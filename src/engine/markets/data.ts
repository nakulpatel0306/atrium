import type { Database } from "bun:sqlite";
import { getSetting } from "../settings";
import { dailyBudget, hourlyBudget, meteredFetch, noteSourceResult, YAHOO_DAILY_CAP } from "./budget";
import { cachedBars, cachedQuotes, saveBars, saveQuotes } from "./cache";
import { closes, recordCloses } from "./closes";
import { etClock, etDate, etInstant, lastCompletedSession } from "./calendar";
import { instrumentKey, type Instrument } from "./instrument";
import { KEY_ACCOUNTS, KEYCHAIN_LOCKED, type Keychain } from "./keychain";
import { alpacaProvider } from "./providers/alpaca";
import { alphaVantageProvider } from "./providers/alphavantage";
import { demoProvider } from "./providers/demo";
import { finnhubProvider } from "./providers/finnhub";
import { tiingoProvider, tiingoSymbols, type TiingoProvider } from "./providers/tiingo";
import { yahooProvider, type YahooProvider } from "./providers/yahoo";
import { ProviderError, type Bar, type Freshness, type MarketProvider, type NewsItem, type ProviderId, type Quote, type Timeframe } from "./providers/types";
import { redact } from "./redact";

export type ChartRange = "5D" | "1M" | "3M" | "6M" | "1Y";
export type BarsResult = { key: string; timeframe: Timeframe; bars: Bar[]; source: ProviderId | null; freshness: Freshness | null; note: string | null };
export type DataStatus = {
  usProvider: "finnhub" | "demo";
  us: { ready: boolean; message: string };
  ca: { ready: boolean; message: string };
  keys: { alpaca: boolean; finnhub: boolean; alphavantage: boolean; tiingo: boolean };
  // Where US daily history (charts, performance, indicators) comes from.
  history: { ready: boolean; message: string };
};
export type MarketData = {
  quotes(list: Instrument[]): Promise<{ quotes: Quote[]; missing: { key: string; reason: string }[] }>;
  bars(i: Instrument, range: ChartRange): Promise<BarsResult>;
  news(list: Instrument[], since: number): Promise<NewsItem[]>;
  streamer(): MarketProvider | null;
  status(): Promise<DataStatus>;
  reload(): Promise<void>;
  // Reads the Keychain if the feed is about to fetch and keys are missing or unread (at most every ten minutes).
  prepare(): Promise<void>;
  // The same for a user action (Settings, a markets space, Test); force reads straight away.
  refreshKeys(force?: boolean): Promise<void>;
  providerFor(i: Instrument): MarketProvider | null;
  // Why nothing prices this instrument right now; null when a provider covers it.
  reasonFor(i: Instrument): string | null;
  secrets(): string[];
  // The Tiingo provider for the end-of-day job, or null without a key.
  tiingo?(): TiingoProvider | null;
  // Where earnings dates, metrics and profiles come from: Finnhub when it has a key, Demo in Demo mode.
  research?(): MarketProvider | null;
};

export const AV_DAILY_LIMIT = 25;
// Tiingo's free plan allows 1,000 a day and 50 an hour; Atrium stops a little short.
export const TIINGO_DAILY_LIMIT = 950;
export const TIINGO_HOURLY_LIMIT = 48;
const DAY_MS = 86_400_000;
const RANGE_DAYS: Record<Exclude<ChartRange, "5D">, number> = { "1M": 31, "3M": 92, "6M": 183, "1Y": 366 };
// Enough calendar days to hold five sessions across a long weekend.
const FIVE_DAY_SPAN_MS = 8 * DAY_MS;

export const MISSING = {
  alpaca: "Add your Alpaca key in Settings → Market data.",
  finnhub: "Add your Finnhub key in Settings → Market data.",
  ca: "No Canadian price yet. Yahoo Finance fills in during TSX hours; a free Alpha Vantage key (Settings → Market data) adds the official close.",
  neo: "No free source covers NEO-listed CDRs.",
  otc: "No free source covers OTC stocks.",
  history: "Atrium's own daily closes from Finnhub prices. History builds up over time.",
};

const FRESHNESS: Record<ProviderId, Freshness> = { alpaca: "live", finnhub: "live", alphavantage: "eod", tiingo: "eod", yahoo: "live", demo: "demo" };

const YAHOO_PAUSE_KEY = "markets.yahoo.pausedUntil";

const isCanadian = (i: Instrument) => i.exchange === "TSX" || i.exchange === "TSXV";
const CA_SOURCES = new Set<ProviderId>(["yahoo", "alphavantage"]);

// Yahoo's intraday price and Alpha Vantage's close share one cached row per listing, and the newer is "price now".
// A Yahoo price that's no longer live never replaces a stored close from Alpha Vantage.
function replacesCached(q: Quote, old: Quote | undefined): boolean {
  if (!old || !CA_SOURCES.has(old.source) || old.source === q.source) return true;
  if (q.source === "yahoo" && q.freshness !== "live") return false;
  return q.at > old.at;
}

type Keys = { alpacaKeyId: string | null; alpacaSecret: string | null; finnhub: string | null; alphavantage: string | null; tiingo: string | null };

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
  let keys: Keys = { alpacaKeyId: null, alpacaSecret: null, finnhub: null, alphavantage: null, tiingo: null };
  let loaded: Promise<void> | null = null;
  let built: Partial<Record<ProviderId, MarketProvider>> = {};
  // A provider that rejected its key says so in the status until the keys change, or until the next session's first
  // fetch, which tries once more.
  let rejected: Partial<Record<ProviderId, { message: string; date: string }>> = {};
  let lastRead = 0;
  let readFailed = false;
  // Keyless, so it lives outside `built`. Its pause is kept in settings (written directly, no `changed`) so a restart
  // doesn't ask Yahoo again early. Substituted providers replace it too: a caller passing fakes reaches nothing else.
  const yahooPause = {
    get: () => Number(getSetting(db, YAHOO_PAUSE_KEY) ?? 0),
    set: (until: number) =>
      db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(YAHOO_PAUSE_KEY, String(until)),
  };
  const yahoo: YahooProvider | null = deps.providers
    ? ((deps.providers.yahoo as YahooProvider | undefined) ?? null)
    : yahooProvider({
        budget: dailyBudget(db, "yahoo", YAHOO_DAILY_CAP, now),
        cap: YAHOO_DAILY_CAP,
        fetch: meteredFetch(db, "yahoo", deps.fetch ?? fetch, now),
        now,
        pause: yahooPause,
      });

  const read = async (account: string) => {
    try {
      return await deps.keychain.get(account);
    } catch {
      readFailed = true;
      return null;
    }
  };
  const reload = async () => {
    readFailed = false;
    lastRead = now();
    rejected = {};
    keys = {
      alpacaKeyId: await read(KEY_ACCOUNTS.alpacaKeyId),
      alpacaSecret: await read(KEY_ACCOUNTS.alpacaSecret),
      finnhub: await read(KEY_ACCOUNTS.finnhub),
      alphavantage: await read(KEY_ACCOUNTS.alphavantage),
      tiingo: await read(KEY_ACCOUNTS.tiingo),
    };
    built = {};
  };
  // The Keychain is read only when something needs the keys: the feed about to fetch in market hours (prepare), or
  // Nakul opening Settings or a markets space (refreshKeys). A missing key or a failed (locked) read is retried at
  // most every ten minutes from the feed, half a minute from a user action, and never from status().
  const missingKey = () => mode() !== "demo" && !has.finnhub();
  const readIfDue = async (gapMs: number, force = false) => {
    if (loaded) await loaded;
    const due = !loaded || force || ((readFailed || missingKey()) && now() - lastRead > gapMs);
    if (!due) return;
    loaded = reload();
    await loaded;
  };
  const ensure = async () => {
    await readIfDue(600_000);
    const today = etDate(now());
    for (const id of Object.keys(rejected) as ProviderId[]) if (rejected[id]!.date !== today) delete rejected[id];
  };

  const has = {
    alpaca: () => !!(keys.alpacaKeyId && keys.alpacaSecret),
    finnhub: () => !!keys.finnhub,
    alphavantage: () => !!keys.alphavantage,
    tiingo: () => !!keys.tiingo,
  };
  const mode = (): DataStatus["usProvider"] => {
    // Finnhub is the default; Alpaca is off the default path (a stored "alpaca" is migrated at boot).
    return getSetting(db, "markets.provider") === "demo" ? "demo" : "finnhub";
  };

  // Alpha Vantage's daily series cost one of 25 calls a day, so every one fetched is kept: completed sessions go to
  // the bar cache and to Atrium's own closes.
  const keepDaily = (key: string, days: { date: string; bar: Bar }[]) => {
    const done = days.filter((d) => d.date < etDate(now()) || lastCompletedSession(now()).date === d.date);
    saveBars(db, key, "1Day", done.map((d) => d.bar));
    recordCloses(db, key, done.map((d) => ({ date: d.date, close: d.bar.c, adjClose: null, source: "alphavantage" })));
  };
  const provider = (id: ProviderId): MarketProvider => {
    const given = deps.providers?.[id];
    if (given) return given;
    const cached = built[id];
    if (cached) return cached;
    // Every request a provider sends is counted for the data budget page.
    const metered = id === "demo" ? undefined : meteredFetch(db, id, deps.fetch ?? fetch, now);
    const io = { fetch: metered, WebSocket: deps.WebSocket, now };
    const made =
      id === "alpaca"
        ? alpacaProvider({ keyId: keys.alpacaKeyId!, secret: keys.alpacaSecret! }, io)
        : id === "finnhub"
          ? finnhubProvider(keys.finnhub!, io)
          : id === "alphavantage"
            ? alphaVantageProvider(keys.alphavantage!, { budget: dailyBudget(db, "alphavantage", AV_DAILY_LIMIT, now), fetch: metered, now, onDaily: keepDaily })
            : id === "tiingo"
              ? tiingoProvider(keys.tiingo!, {
                  fetch: metered,
                  now,
                  budget: { day: dailyBudget(db, "tiingo", TIINGO_DAILY_LIMIT, now), hour: hourlyBudget(db, "tiingo", TIINGO_HOURLY_LIMIT, now) },
                  symbols: tiingoSymbols(db, now),
                })
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
    // Yahoo only while it may be asked (TSX in session, not paused, under its cap); Alpha Vantage's close otherwise.
    if (yahoo?.live()) return { provider: yahoo, reason: "" };
    return closesFor();
  };
  const closesFor = (): { provider: MarketProvider | null; reason: string } =>
    has.alphavantage() ? { provider: provider("alphavantage"), reason: "" } : { provider: null, reason: MISSING.ca };

  const secrets = () => [keys.alpacaKeyId, keys.alpacaSecret, keys.finnhub, keys.alphavantage, keys.tiingo].filter((k): k is string => !!k);
  // US daily bars come from Tiingo when it has a key.
  const historyFor = (i: Instrument): { provider: MarketProvider | null; reason: string } => {
    const m = mode();
    if (m !== "demo" && isCanadian(i)) return closesFor();
    if (m === "demo" || i.exchange !== "US") return route(i);
    if (has.tiingo()) return { provider: provider("tiingo"), reason: "" };
    return { provider: null, reason: MISSING.history };
  };
  const message = (e: unknown) => redact(e instanceof Error ? e.message : String(e), secrets());
  const note = (p: MarketProvider, ok: boolean, msg?: string) => {
    if (p.id !== "demo") noteSourceResult(db, p.id, ok, msg, now());
  };

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
    let noteText: string | null = null;
    if (!coversFrom || !current) {
      const fetchFrom = coversFrom && latest !== null ? latest * 1000 : from;
      try {
        const fresh = (await p.bars(i, "1Day", fetchFrom, at)).filter((b) => b.t < cutoff);
        note(p, true);
        saveBars(db, key, "1Day", fresh);
        setMeta(key, { from: coversFrom ? meta!.from : from, fetchedAt: at });
      } catch (e) {
        noteText = message(e);
        if (!(e instanceof ProviderError && e.kind === "no_history")) note(p, false, noteText);
      }
    }
    return { bars: cachedBars(db, key, "1Day", Math.floor(from / 1000)), note: noteText };
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
          note(p, true);
          const cached = cachedQuotes(db, got.map((q) => q.key));
          const kept = got.map((q) => (replacesCached(q, cached.get(q.key)) ? q : cached.get(q.key)!));
          saveQuotes(db, kept.filter((q) => q.source === p.id));
          quotes.push(...kept);
          const seen = new Set(got.map((q) => q.key));
          for (const i of group) if (!seen.has(instrumentKey(i))) missing.push({ key: instrumentKey(i), reason: `${p.label} has no price for ${instrumentKey(i)}.` });
        } catch (e) {
          const reason = message(e);
          note(p, false, reason);
          if (e instanceof ProviderError && e.kind === "auth") rejected[p.id] = { message: reason, date: etDate(now()) };
          for (const i of group) missing.push({ key: instrumentKey(i), reason });
        }
      }
      return { quotes, missing };
    },
    async bars(i, range) {
      await ensure();
      const key = instrumentKey(i);
      const timeframe: Timeframe = range === "5D" ? "5Min" : "1Day";
      // Canadian charts always come from Alpha Vantage; Yahoo only prices the day.
      const r = range === "5D" && !isCanadian(i) ? route(i) : historyFor(i);
      if (!r.provider && range !== "5D" && i.exchange === "US" && mode() !== "demo") {
        // Tiingo is optional: without it, US history is the closes Atrium keeps from Finnhub's prices.
        const own = closes(db, key, etDate(now() - RANGE_DAYS[range] * DAY_MS)).map((c) => {
          const t = etInstant(c.date, "00:00") / 1000;
          return { t, o: c.close, h: c.close, l: c.close, c: c.close, v: 0 };
        });
        return { key, timeframe, bars: own, source: null, freshness: null, note: MISSING.history };
      }
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
          note(p, true);
        } catch (e) {
          note(p, false, message(e));
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
      const m = mode();
      const keysPresent = { alpaca: has.alpaca(), finnhub: has.finnhub(), alphavantage: has.alphavantage(), tiingo: has.tiingo() };
      if (m === "demo") {
        const demo = { ready: true, message: "Demo data" };
        return { usProvider: m, us: demo, ca: demo, keys: keysPresent, history: demo };
      }
      const tiingoLeft = dailyBudget(db, "tiingo", TIINGO_DAILY_LIMIT, now).remaining();
      const history = rejected.tiingo
        ? { ready: false, message: rejected.tiingo.message }
        : has.tiingo()
          ? { ready: true, message: `Tiingo · end of day (${tiingoLeft} of ${TIINGO_DAILY_LIMIT} requests left today)` }
          : { ready: true, message: "Atrium's own daily closes · builds up over time" };
      const us = !has[m]()
        ? { ready: false, message: readFailed ? KEYCHAIN_LOCKED : MISSING[m] }
        : rejected[m]
          ? { ready: false, message: rejected[m]!.message }
          : { ready: true, message: "Finnhub · real-time" };
      const left = dailyBudget(db, "alphavantage", AV_DAILY_LIMIT, now).remaining();
      const paused = yahoo ? yahoo.pausedUntil() : 0;
      const day = !yahoo ? null : paused > now() ? `Yahoo Finance paused until ${etClock(paused)} after an error` : "Yahoo Finance during TSX hours (a few minutes delayed)";
      const ca = rejected.alphavantage
        ? { ready: false, message: rejected.alphavantage.message }
        : has.alphavantage()
        ? { ready: true, message: `${day ? `${day}; after the close, ` : ""}Alpha Vantage · end of day (${left} of ${AV_DAILY_LIMIT} requests left today)` }
        : day
          ? { ready: true, message: `${day} · add a free Alpha Vantage key for the official close` }
          : { ready: false, message: MISSING.ca };
      return { usProvider: m, us, ca, keys: keysPresent, history };
    },
    prepare: ensure,
    refreshKeys: (force = false) => readIfDue(30_000, force),
    async reload() {
      loaded = reload();
      await loaded;
    },
    providerFor(i) {
      return route(i).provider;
    },
    reasonFor(i) {
      const r = route(i);
      return r.provider ? null : r.reason;
    },
    secrets,
    tiingo() {
      return has.tiingo() ? (provider("tiingo") as TiingoProvider) : null;
    },
    research() {
      if (mode() === "demo") return provider("demo");
      return has.finnhub() ? provider("finnhub") : null;
    },
  };
}

// A cached price only counts when today's source for the instrument produced it: after switching from Demo to
// Alpaca, demo prices must not show, or fill paper orders, as if they were real (and the reverse).
// Canadian listings have two real sources, Yahoo in the day and Alpha Vantage after it; either counts outside Demo
// mode, so a Yahoo price still prices a holding after the close or without an Alpha Vantage key.
export function currentQuote(db: Database, data: MarketData, i: Instrument): Quote | null {
  const p = data.providerFor(i);
  const q = cachedQuotes(db, [instrumentKey(i)]).get(instrumentKey(i));
  if (!q) return null;
  if (p && q.source === p.id) return q;
  return isCanadian(i) && CA_SOURCES.has(q.source) && getSetting(db, "markets.provider") !== "demo" ? q : null;
}
