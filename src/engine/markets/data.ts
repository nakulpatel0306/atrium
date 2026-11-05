import type { Database } from "bun:sqlite";
import { getSetting } from "../settings";
import { dailyBudget } from "./budget";
import { cachedBars, saveBars, saveQuotes } from "./cache";
import { etDate, etInstant, lastCompletedSession } from "./calendar";
import { instrumentKey, type Instrument } from "./instrument";
import { KEY_ACCOUNTS, type Keychain } from "./keychain";
import { alpacaProvider } from "./providers/alpaca";
import { alphaVantageProvider } from "./providers/alphavantage";
import { demoProvider } from "./providers/demo";
import { finnhubProvider } from "./providers/finnhub";
import { ProviderError, type Bar, type Freshness, type MarketProvider, type NewsItem, type ProviderId, type Quote, type Timeframe } from "./providers/types";
import { redact } from "./redact";

export type ChartRange = "5D" | "1M" | "3M" | "6M" | "1Y";
export type BarsResult = { key: string; timeframe: Timeframe; bars: Bar[]; source: ProviderId | null; freshness: Freshness | null; note: string | null };
export type DataStatus = {
  usProvider: "alpaca" | "finnhub" | "demo";
  us: { ready: boolean; message: string };
  ca: { ready: boolean; message: string };
  keys: { alpaca: boolean; finnhub: boolean; alphavantage: boolean };
};
export type MarketData = {
  quotes(list: Instrument[]): Promise<{ quotes: Quote[]; missing: { key: string; reason: string }[] }>;
  bars(i: Instrument, range: ChartRange): Promise<BarsResult>;
  news(list: Instrument[], since: number): Promise<NewsItem[]>;
  streamer(): MarketProvider | null;
  status(): Promise<DataStatus>;
  reload(): Promise<void>;
  providerFor(i: Instrument): MarketProvider | null;
  secrets(): string[];
};

export const AV_DAILY_LIMIT = 25;
const DAY_MS = 86_400_000;
const RANGE_DAYS: Record<Exclude<ChartRange, "5D">, number> = { "1M": 31, "3M": 92, "6M": 183, "1Y": 366 };
// Enough calendar days to hold five sessions across a long weekend.
const FIVE_DAY_SPAN_MS = 8 * DAY_MS;

export const MISSING = {
  alpaca: "Add your Alpaca key in Settings → Market data.",
  finnhub: "Add your Finnhub key in Settings → Market data.",
  ca: "Canadian prices need a free Alpha Vantage key (Settings → Market data).",
  neo: "No free source covers NEO-listed CDRs.",
  otc: "Alpaca's free plan doesn't include OTC stocks.",
};

const FRESHNESS: Record<ProviderId, Freshness> = { alpaca: "live", finnhub: "live", alphavantage: "eod", demo: "demo" };

type Keys = { alpacaKeyId: string | null; alpacaSecret: string | null; finnhub: string | null; alphavantage: string | null };

export function createMarketData(deps: {
  db: Database;
  keychain: Keychain;
  fetch?: typeof fetch;
  WebSocket?: typeof WebSocket;
  now?: () => number;
  providers?: Partial<Record<ProviderId, MarketProvider>>;
}): MarketData {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  let keys: Keys = { alpacaKeyId: null, alpacaSecret: null, finnhub: null, alphavantage: null };
  let loaded: Promise<void> | null = null;
  let built: Partial<Record<ProviderId, MarketProvider>> = {};

  const read = async (account: string) => {
    try {
      return await deps.keychain.get(account);
    } catch {
      return null;
    }
  };
  const reload = async () => {
    keys = {
      alpacaKeyId: await read(KEY_ACCOUNTS.alpacaKeyId),
      alpacaSecret: await read(KEY_ACCOUNTS.alpacaSecret),
      finnhub: await read(KEY_ACCOUNTS.finnhub),
      alphavantage: await read(KEY_ACCOUNTS.alphavantage),
    };
    built = {};
  };
  const ensure = () => (loaded ??= reload());

  const has = { alpaca: () => !!(keys.alpacaKeyId && keys.alpacaSecret), finnhub: () => !!keys.finnhub, alphavantage: () => !!keys.alphavantage };
  const mode = (): DataStatus["usProvider"] => {
    const v = getSetting(db, "markets.provider");
    return v === "finnhub" || v === "demo" ? v : "alpaca";
  };

  const provider = (id: ProviderId): MarketProvider => {
    const given = deps.providers?.[id];
    if (given) return given;
    const cached = built[id];
    if (cached) return cached;
    const io = { fetch: deps.fetch, WebSocket: deps.WebSocket, now };
    const made =
      id === "alpaca"
        ? alpacaProvider({ keyId: keys.alpacaKeyId!, secret: keys.alpacaSecret! }, io)
        : id === "finnhub"
          ? finnhubProvider(keys.finnhub!, io)
          : id === "alphavantage"
            ? alphaVantageProvider(keys.alphavantage!, { budget: dailyBudget(db, "alphavantage", AV_DAILY_LIMIT, now), fetch: deps.fetch, now })
            : demoProvider({ now });
    built[id] = made;
    return made;
  };

  const route = (i: Instrument): { provider: MarketProvider | null; reason: string } => {
    const m = mode();
    if (m === "demo") return { provider: provider("demo"), reason: "" };
    if (i.exchange === "NEO") return { provider: null, reason: MISSING.neo };
    if (i.exchange === "OTC") return { provider: null, reason: MISSING.otc };
    if (i.exchange === "US") return has[m]() ? { provider: provider(m), reason: "" } : { provider: null, reason: MISSING[m] };
    return has.alphavantage() ? { provider: provider("alphavantage"), reason: "" } : { provider: null, reason: MISSING.ca };
  };

  const secrets = () => [keys.alpacaKeyId, keys.alpacaSecret, keys.finnhub, keys.alphavantage].filter((k): k is string => !!k);
  const message = (e: unknown) => redact(e instanceof Error ? e.message : String(e), secrets());

  // Bookkeeping for the daily-bar cache, written directly so it doesn't emit `changed`.
  type BarsMeta = { from: number; fetchedAt: number };
  const metaKey = (key: string) => `markets.bars.${key}`;
  const getMeta = (key: string): BarsMeta | null => {
    const raw = getSetting(db, metaKey(key));
    return raw ? (JSON.parse(raw) as BarsMeta) : null;
  };
  const setMeta = (key: string, m: BarsMeta) =>
    db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(metaKey(key), JSON.stringify(m));

  const dailyBars = async (p: MarketProvider, i: Instrument, from: number): Promise<{ bars: Bar[]; note: string | null }> => {
    const key = instrumentKey(i);
    const at = now();
    const last = lastCompletedSession(at);
    // A bar for a session still in progress isn't a close yet, so it never enters the cache.
    const todayStart = etInstant(etDate(at), "00:00") / 1000;
    const cutoff = last.date === etDate(at) ? Infinity : todayStart;
    const cached = cachedBars(db, key, "1Day", 0);
    const meta = getMeta(key);
    const latest = cached.at(-1)?.t ?? null;
    const coversFrom = meta !== null && meta.from <= from;
    const current = (latest !== null && latest >= etInstant(last.date, "00:00") / 1000) || (meta !== null && meta.fetchedAt >= last.closesAt);
    let note: string | null = null;
    if (!coversFrom || !current) {
      const fetchFrom = coversFrom && latest !== null ? latest * 1000 : from;
      try {
        const fresh = (await p.bars(i, "1Day", fetchFrom, at)).filter((b) => b.t < cutoff);
        saveBars(db, key, "1Day", fresh);
        setMeta(key, { from: coversFrom ? meta!.from : from, fetchedAt: at });
      } catch (e) {
        note = message(e);
      }
    }
    return { bars: cachedBars(db, key, "1Day", Math.floor(from / 1000)), note };
  };

  return {
    async quotes(list) {
      await ensure();
      const quotes: Quote[] = [];
      const missing: { key: string; reason: string }[] = [];
      const groups = new Map<MarketProvider, Instrument[]>();
      for (const i of list) {
        const r = route(i);
        if (!r.provider) missing.push({ key: instrumentKey(i), reason: r.reason });
        else groups.set(r.provider, [...(groups.get(r.provider) ?? []), i]);
      }
      for (const [p, group] of groups) {
        try {
          const got = await p.quotes(group);
          saveQuotes(db, got);
          quotes.push(...got);
          const seen = new Set(got.map((q) => q.key));
          for (const i of group) if (!seen.has(instrumentKey(i))) missing.push({ key: instrumentKey(i), reason: `${p.label} has no price for ${instrumentKey(i)}.` });
        } catch (e) {
          const reason = message(e);
          for (const i of group) missing.push({ key: instrumentKey(i), reason });
        }
      }
      return { quotes, missing };
    },
    async bars(i, range) {
      await ensure();
      const key = instrumentKey(i);
      const timeframe: Timeframe = range === "5D" ? "5Min" : "1Day";
      const r = route(i);
      if (!r.provider) return { key, timeframe, bars: [], source: null, freshness: null, note: r.reason };
      const p = r.provider;
      const base = { key, timeframe, source: p.id, freshness: FRESHNESS[p.id] };
      if (range === "5D") {
        try {
          const bars = await p.bars(i, "5Min", now() - FIVE_DAY_SPAN_MS, now());
          const note = p.id === "alpaca" ? "5-day volume is from IEX only, a few percent of all US trading." : null;
          return { ...base, bars, note };
        } catch (e) {
          return { ...base, bars: [], note: message(e) };
        }
      }
      const { bars, note } = await dailyBars(p, i, now() - RANGE_DAYS[range] * DAY_MS);
      return { ...base, bars, note };
    },
    async news(list, since) {
      await ensure();
      const groups = new Map<MarketProvider, Instrument[]>();
      for (const i of list) {
        const p = route(i).provider;
        if (p?.news) groups.set(p, [...(groups.get(p) ?? []), i]);
      }
      const out: NewsItem[] = [];
      for (const [p, group] of groups) {
        try {
          out.push(...(await p.news!(group, since)));
        } catch (e) {
          throw new ProviderError(e instanceof ProviderError ? e.kind : "unavailable", message(e));
        }
      }
      return out.sort((a, b) => b.at - a.at);
    },
    streamer() {
      const m = mode();
      if (m === "demo") return provider("demo");
      if (!has[m]()) return null;
      const p = provider(m);
      return p.stream ? p : null;
    },
    async status() {
      await ensure();
      const m = mode();
      const keysPresent = { alpaca: has.alpaca(), finnhub: has.finnhub(), alphavantage: has.alphavantage() };
      if (m === "demo") return { usProvider: m, us: { ready: true, message: "Demo data" }, ca: { ready: true, message: "Demo data" }, keys: keysPresent };
      const us = has[m]() ? { ready: true, message: m === "alpaca" ? "Alpaca · IEX real-time" : "Finnhub · real-time" } : { ready: false, message: MISSING[m] };
      const left = dailyBudget(db, "alphavantage", AV_DAILY_LIMIT, now).remaining();
      const ca = has.alphavantage()
        ? { ready: true, message: `Alpha Vantage · end of day (${left} of ${AV_DAILY_LIMIT} requests left today)` }
        : { ready: false, message: MISSING.ca };
      return { usProvider: m, us, ca, keys: keysPresent };
    },
    async reload() {
      loaded = reload();
      await loaded;
    },
    providerFor(i) {
      return route(i).provider;
    },
    secrets,
  };
}
