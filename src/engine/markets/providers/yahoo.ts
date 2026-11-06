import type { dailyBudget } from "../budget";
import { etDate, tsxOpen } from "../calendar";
import { instrumentKey, type Instrument } from "../instrument";
import { ProviderError, type MarketProvider, type Quote } from "./types";

// Yahoo's public chart feed: unofficial, no key, minutes-old TSX prices. Only the ticker is sent, with a generic
// browser User-Agent (Yahoo refuses obvious scripts) and nothing that identifies Nakul.
const API = "https://query1.finance.yahoo.com/v8/finance/chart";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  Accept: "application/json",
};
const SUFFIX: Partial<Record<Instrument["exchange"], string>> = { TSX: ".TO", TSXV: ".V" };
const TIMEOUT_MS = 10_000;
// After any failure Yahoo is left alone for a while; the last close shows meanwhile.
export const YAHOO_BACKOFF_MS = 15 * 60_000;
const RETRY = "TSX prices show the last close; Atrium tries again in 15 minutes.";
const SHAPE = "Yahoo Finance's reply changed shape, so Atrium can't read TSX prices from it. Showing the last close; Atrium tries again in 15 minutes.";

export type YahooProvider = MarketProvider & {
  // True when a request may go out now: TSX in session, not paused after a failure, and under the daily cap.
  live(): boolean;
  pausedUntil(): number;
  // Atrium's own daily cap is used up.
  capped(): boolean;
  // quotes() with why it stopped early after pricing some tickers (null when it finished), kept per call.
  batch(list: Instrument[], signal?: AbortSignal): Promise<{ quotes: Quote[]; failure: string | null }>;
};

type Meta = { currency?: unknown; regularMarketPrice?: unknown; regularMarketTime?: unknown; previousClose?: unknown; chartPreviousClose?: unknown };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

// pause holds the pause's end (epoch ms); the caller can store it so a restart doesn't ask Yahoo again early.
export function yahooProvider(deps: {
  budget: ReturnType<typeof dailyBudget>;
  cap: number;
  fetch?: typeof fetch;
  now?: () => number;
  pause?: { get(): number; set(until: number): void };
}): YahooProvider {
  const f = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  let held = 0;
  const pause = deps.pause ?? { get: () => held, set: (until: number) => void (held = until) };

  const fail = (kind: "rate_limited" | "unavailable", message: string): never => {
    const until = now() + YAHOO_BACKOFF_MS;
    pause.set(until);
    throw new ProviderError(kind, message, until);
  };

  // Null for a ticker Yahoo doesn't know or doesn't price in CAD; that one is skipped, the rest carry on.
  const quote = async (i: Instrument, signal?: AbortSignal): Promise<Quote | null> => {
    if (!deps.budget.spend()) {
      throw new ProviderError(
        "rate_limited",
        `Atrium's own cap of ${deps.cap.toLocaleString("en-US")} Yahoo Finance requests today is reached. TSX prices show the last close until tomorrow.`,
      );
    }
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    let res: Response;
    try {
      res = await f(`${API}/${encodeURIComponent(`${i.symbol}${SUFFIX[i.exchange]}`)}?interval=1m&range=1d`, {
        headers: HEADERS,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch {
      return fail("unavailable", `Couldn't reach Yahoo Finance. ${RETRY}`);
    }
    if (res.status === 404) return null;
    if (res.status === 429) return fail("rate_limited", `Yahoo Finance says too many requests. ${RETRY}`);
    if (!res.ok) return fail("unavailable", `Yahoo Finance returned an error (HTTP ${res.status}). ${RETRY}`);
    let body: { chart?: { result?: { meta?: Meta }[] | null; error?: { code?: unknown } | null } };
    try {
      body = await res.json();
    } catch {
      return fail("unavailable", SHAPE);
    }
    if (body?.chart?.error?.code === "Not Found") return null;
    const meta = body?.chart?.result?.[0]?.meta;
    const price = num(meta?.regularMarketPrice);
    const time = num(meta?.regularMarketTime);
    if (!meta || price === null || time === null || price <= 0) return fail("unavailable", SHAPE);
    if (meta.currency !== "CAD") return null;
    const at = time * 1000;
    return {
      key: instrumentKey(i),
      price,
      prevClose: num(meta.previousClose) ?? num(meta.chartPreviousClose),
      at,
      source: "yahoo",
      // Live however long ago today's last trade was (staleness is judged from fetchedAt); a trade from an earlier
      // session, before a thin listing's first trade of the day, is that session's last price.
      freshness: etDate(at) === etDate(now()) ? "live" : "eod",
      fetchedAt: now(),
    };
  };

  const covers = (i: Instrument) => i.exchange in SUFFIX;
  const live = () => tsxOpen(now()) && now() >= pause.get() && deps.budget.remaining() > 0;
  // Outside TSX hours, while paused, or for anything but a Canadian listing, nothing is sent at all. A failure
  // partway keeps the prices already fetched and stops there (the pause is already set).
  const batch = async (list: Instrument[], signal?: AbortSignal): Promise<{ quotes: Quote[]; failure: string | null }> => {
    if (!tsxOpen(now()) || now() < pause.get()) return { quotes: [], failure: null };
    const out: Quote[] = [];
    for (const i of list.filter(covers)) {
      try {
        const q = await quote(i, signal);
        if (q) out.push(q);
      } catch (e) {
        if (!out.length) throw e;
        return { quotes: out, failure: e instanceof Error ? e.message : String(e) };
      }
    }
    return { quotes: out, failure: null };
  };
  const quotes = async (list: Instrument[], signal?: AbortSignal) => (await batch(list, signal)).quotes;

  return {
    id: "yahoo",
    label: "Yahoo Finance",
    covers,
    live,
    pausedUntil: () => pause.get(),
    capped: () => deps.budget.remaining() <= 0,
    batch,
    quotes,
    async bars() {
      throw new ProviderError("no_history", "Yahoo Finance is only used for TSX prices during the day; charts use Alpha Vantage's closes.");
    },
    // Through the same guards as quotes(), so a check never reaches Yahoo outside TSX hours or during a pause.
    async validate() {
      await quotes([{ symbol: "XEQT", exchange: "TSX" }]);
    },
  };
}
