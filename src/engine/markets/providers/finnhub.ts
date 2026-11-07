import { etDate } from "../calendar";
import { instrumentKey, type Instrument } from "../instrument";
import { finnhubHits } from "../search";
import { fetchJson, RECONNECT_MS } from "./http";
import { ProviderError, type EarningsDate, type MarketProvider, type Metrics, type NewsItem, type Profile, type Quote, type QuoteStream, type StreamEvents } from "./types";

const API = "https://finnhub.io/api/v1";
const AUTH_MESSAGE = "Finnhub rejected the token. Check it in Settings → Market data.";

type Deps = {
  fetch?: typeof fetch;
  // Waits before each REST call; one pacer is shared by every Finnhub provider the engine builds.
  pace?: () => Promise<void>;
  WebSocket?: typeof WebSocket;
  now?: () => number;
  timers?: { set: typeof setTimeout; clear: typeof clearTimeout };
};

// Finnhub's free plan allows 60 calls a minute; Atrium keeps to 50 across every caller (feed, jobs, Symbol pages).
export const FINNHUB_PER_MINUTE = 50;

// At most `limit` calls in any `windowMs`: a call that would exceed it waits until the oldest one leaves the window.
export function pacer(limit: number, windowMs: number, clock: () => number = Date.now, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))) {
  const sent: number[] = [];
  let chain: Promise<void> = Promise.resolve();
  return (): Promise<void> => {
    const turn = chain.then(async () => {
      while (sent.length && clock() - sent[0]! >= windowMs) sent.shift();
      if (sent.length >= limit) {
        await sleep(sent[0]! + windowMs - clock());
        sent.shift();
      }
      sent.push(clock());
    });
    chain = turn;
    return turn;
  };
}

// The token travels in the query string, so URLs are never logged or echoed (see http.ts).
export function finnhubProvider(token: string, deps: Deps = {}): MarketProvider {
  const f = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const WS = deps.WebSocket ?? WebSocket;
  const timers = deps.timers ?? { set: setTimeout, clear: clearTimeout };
  const prevCloses = new Map<string, number>();

  const get = async (path: string, params: Record<string, string>, signal?: AbortSignal) => {
    await deps.pace?.();
    return fetchJson(`${API}${path}?${new URLSearchParams({ ...params, token })}`, { fetch: f, name: "Finnhub", authMessage: AUTH_MESSAGE, now, signal });
  };

  const quotes = async (list: Instrument[], signal?: AbortSignal): Promise<Quote[]> => {
    const out: Quote[] = [];
    for (const i of list) {
      const q = (await get("/quote", { symbol: i.symbol }, signal)) as { c: number; pc: number; t: number };
      if (!q.c && !q.t) throw new ProviderError("unknown_symbol", `Finnhub doesn't know ${instrumentKey(i)}.`);
      if (q.pc) prevCloses.set(i.symbol, q.pc);
      out.push({ key: instrumentKey(i), price: q.c, prevClose: q.pc || null, at: q.t * 1000, source: "finnhub", freshness: "live" });
    }
    return out;
  };

  const news = async (list: Instrument[], since: number): Promise<NewsItem[]> => {
    const out: NewsItem[] = [];
    for (const i of list) {
      const items = (await get("/company-news", { symbol: i.symbol, from: etDate(since), to: etDate(now()) })) as {
        datetime: number;
        headline: string;
        source: string;
        url: string;
      }[];
      for (const n of items) out.push({ key: instrumentKey(i), headline: n.headline, source: n.source, url: n.url, at: n.datetime * 1000 });
    }
    return out;
  };

  const numOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const metric = async (i: Instrument): Promise<Metrics> => {
    const r = (await get("/stock/metric", { symbol: i.symbol, metric: "all" })) as { metric?: Record<string, unknown> };
    const m = r?.metric ?? {};
    return {
      pe: numOrNull(m.peTTM),
      high52: numOrNull(m["52WeekHigh"]),
      low52: numOrNull(m["52WeekLow"]),
      divYield: numOrNull(m.currentDividendYieldTTM),
      marketCap: numOrNull(m.marketCapitalization),
    };
  };
  const profile = async (i: Instrument): Promise<Profile | null> => {
    const r = (await get("/stock/profile2", { symbol: i.symbol })) as { name?: string; country?: string; currency?: string; finnhubIndustry?: string; exchange?: string };
    if (!r?.name) return null;
    return { name: r.name, country: r.country || null, currency: r.currency || null, industry: r.finnhubIndustry || null, exchange: r.exchange || null };
  };
  const earnings = async (list: Instrument[], from: string, to: string): Promise<EarningsDate[]> => {
    const out: EarningsDate[] = [];
    const done: string[] = [];
    const failed: { key: string; reason: string }[] = [];
    for (const i of list) {
      let r: { earningsCalendar?: { date: string; hour: string; epsEstimate: number | null; symbol: string }[] };
      try {
        r = (await get("/calendar/earnings", { from, to, symbol: i.symbol })) as typeof r;
      } catch (e) {
        // A rate limit or a rejected key stops the rest; what came back before it is kept, so the caller can save it
        // and ask for the rest later. Any other error is that symbol's alone, and the next symbols are still asked.
        if (!(e instanceof ProviderError)) throw e;
        if (e.kind === "rate_limited" || e.kind === "auth") {
          e.partial = { done, rows: out, failed };
          throw e;
        }
        failed.push({ key: instrumentKey(i), reason: e.message });
        continue;
      }
      for (const e of r?.earningsCalendar ?? []) {
        if (e.symbol !== i.symbol || !/^\d{4}-\d{2}-\d{2}$/.test(e.date)) continue;
        out.push({ key: instrumentKey(i), date: e.date, hour: e.hour || null, epsEstimate: numOrNull(e.epsEstimate) });
      }
      done.push(instrumentKey(i));
    }
    if (failed.length) {
      const e = new ProviderError("unavailable", `Finnhub's earnings calendar failed for ${failed.map((f) => f.key).join(", ")}: ${failed[0]!.reason}`);
      e.partial = { done, rows: out, failed };
      throw e;
    }
    return out;
  };

  const stream = (list: Instrument[], ev: StreamEvents): QuoteStream => {
    let symbols = list.map((x) => x.symbol);
    let ws: WebSocket | null = null;
    let isOpen = false;
    let stopped = false;
    let attempt = 0;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const send = (msg: unknown) => ws?.send(JSON.stringify(msg));
    const connect = () => {
      isOpen = false;
      const sock = new WS(`wss://ws.finnhub.io?${new URLSearchParams({ token })}`);
      ws = sock;
      sock.onopen = () => {
        isOpen = true;
        attempt = 0;
        ev.status({ ok: true, message: "Finnhub real-time" });
        for (const s of symbols) send({ type: "subscribe", symbol: s });
      };
      sock.onmessage = (e: MessageEvent) => {
        let m: { type?: string; data?: { s: string; p: number; t: number }[] };
        try {
          m = JSON.parse(String(e.data));
        } catch {
          return;
        }
        if (m.type === "error") {
          // A rejected token won't start working by retrying; the stream stays closed until the keys change.
          if (/api key|token|auth/i.test(String((m as { msg?: unknown }).msg ?? ""))) {
            stopped = true;
            ev.status({ ok: false, message: AUTH_MESSAGE });
            sock.close();
            return;
          }
          ev.status({ ok: false, message: "Finnhub's live feed reported a problem. Checking every 3 minutes instead." });
        }
        if (m.type !== "trade") return;
        for (const t of m.data ?? []) {
          if (!symbols.includes(t.s)) continue;
          ev.quote({ key: t.s, price: t.p, prevClose: prevCloses.get(t.s) ?? null, at: t.t, source: "finnhub", freshness: "live" });
        }
      };
      sock.onclose = () => {
        if (stopped || ws !== sock) return;
        const delay = RECONNECT_MS[Math.min(attempt, RECONNECT_MS.length - 1)]!;
        attempt++;
        retry = timers.set(connect, delay);
      };
    };
    connect();
    return {
      set(next) {
        const nextSymbols = next.map((x) => x.symbol);
        const removed = symbols.filter((s) => !nextSymbols.includes(s));
        const added = nextSymbols.filter((s) => !symbols.includes(s));
        symbols = nextSymbols;
        if (!isOpen) return;
        for (const s of removed) send({ type: "unsubscribe", symbol: s });
        for (const s of added) send({ type: "subscribe", symbol: s });
      },
      close() {
        stopped = true;
        if (retry) timers.clear(retry);
        ws?.close();
      },
    };
  };

  return {
    id: "finnhub",
    label: "Finnhub",
    covers: (i) => i.exchange === "US",
    quotes,
    async bars() {
      throw new ProviderError("no_history", "Finnhub's free plan has no price history. Switch to Alpaca in Settings → Market data for charts.");
    },
    news,
    metric,
    profile,
    async search(q, signal) {
      const r = (await get("/search", { q }, signal)) as { result?: { description: string; symbol: string; type: string }[] };
      return finnhubHits(r?.result ?? []);
    },
    earnings,
    stream,
    maxStreamSymbols: 50,
    async validate() {
      await quotes([{ symbol: "SPY", exchange: "US" }]);
    },
  };
}
