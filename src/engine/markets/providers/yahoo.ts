import type { dailyBudget } from "../budget";
import { tsxOpen } from "../calendar";
import { instrumentKey, type Instrument } from "../instrument";
import { STALE_LIVE_MS } from "../labels";
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
};

type Meta = { currency?: unknown; regularMarketPrice?: unknown; regularMarketTime?: unknown; previousClose?: unknown; chartPreviousClose?: unknown };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function yahooProvider(deps: { budget: ReturnType<typeof dailyBudget>; cap: number; fetch?: typeof fetch; now?: () => number }): YahooProvider {
  const f = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  let paused = 0;

  const fail = (kind: "rate_limited" | "unavailable", message: string): never => {
    paused = now() + YAHOO_BACKOFF_MS;
    throw new ProviderError(kind, message, paused);
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
      // A trade this old is no longer "now"; the caller keeps the stored close instead.
      freshness: now() - at <= STALE_LIVE_MS ? "live" : "eod",
    };
  };

  const live = () => tsxOpen(now()) && now() >= paused && deps.budget.remaining() > 0;

  return {
    id: "yahoo",
    label: "Yahoo Finance",
    covers: (i) => i.exchange in SUFFIX,
    live,
    pausedUntil: () => paused,
    async quotes(list, signal) {
      // Outside TSX hours, or while paused, nothing is sent at all.
      if (!tsxOpen(now()) || now() < paused) return [];
      const out: Quote[] = [];
      for (const i of list) {
        const q = await quote(i, signal);
        if (q) out.push(q);
      }
      return out;
    },
    async bars() {
      throw new ProviderError("no_history", "Yahoo Finance is only used for TSX prices during the day; charts use Alpha Vantage's closes.");
    },
    async validate() {
      await quote({ symbol: "XEQT", exchange: "TSX" });
    },
  };
}
