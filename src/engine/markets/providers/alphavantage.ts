import type { dailyBudget } from "../budget";
import { etDate, etInstant } from "../calendar";
import { instrumentKey, type Instrument } from "../instrument";
import { fetchJson } from "./http";
import { ProviderError, type Bar, type MarketProvider, type Quote } from "./types";

const API = "https://www.alphavantage.co/query";
const SUFFIX: Partial<Record<Instrument["exchange"], string>> = { TSX: ".TRT", TSXV: ".TRV" };
// compact returns the latest 100 sessions.
const COMPACT_SESSIONS = 100;
const DAY_MS = 86_400_000;

type Daily = Record<string, { "1. open": string; "2. high": string; "3. low": string; "4. close": string; "5. volume": string }>;

const nextEtMidnight = (now: number) => etInstant(new Date(Date.parse(`${etDate(now)}T12:00:00Z`) + DAY_MS).toISOString().slice(0, 10), "00:00");

export function alphaVantageProvider(
  key: string,
  // onDaily sees every daily series fetched, so the caller can keep the bars and closes it already paid for.
  deps: { budget: ReturnType<typeof dailyBudget>; fetch?: typeof fetch; now?: () => number; onDaily?(key: string, days: { date: string; bar: Bar }[]): void },
): MarketProvider {
  const f = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;

  const daily = async (i: Instrument, full: boolean, signal?: AbortSignal): Promise<{ date: string; bar: Bar }[]> => {
    if (!deps.budget.spend()) {
      throw new ProviderError("rate_limited", "Alpha Vantage's free 25 requests for today are used up; Canadian prices refresh tomorrow.", nextEtMidnight(now()));
    }
    const params = new URLSearchParams({
      function: "TIME_SERIES_DAILY",
      symbol: `${i.symbol}${SUFFIX[i.exchange]}`,
      outputsize: full ? "full" : "compact",
      apikey: key,
    });
    const res = (await fetchJson(`${API}?${params}`, {
      fetch: f,
      name: "Alpha Vantage",
      authMessage: "Alpha Vantage rejected the key. Check it in Settings → Market data.",
      now,
      signal,
    })) as { "Time Series (Daily)"?: Daily; Information?: string; Note?: string; "Error Message"?: string };
    // Alpha Vantage answers limits and errors with HTTP 200 and a text field.
    if (res.Information || res.Note) {
      throw new ProviderError("rate_limited", "Alpha Vantage's free daily limit is reached; Canadian prices refresh tomorrow.", nextEtMidnight(now()));
    }
    const series = res["Time Series (Daily)"];
    if (res["Error Message"] || !series) throw new ProviderError("unknown_symbol", `Alpha Vantage doesn't know ${instrumentKey(i)}.`);
    const days = Object.entries(series)
      .map(([date, d]) => ({
        date,
        bar: { t: etInstant(date, "00:00") / 1000, o: Number(d["1. open"]), h: Number(d["2. high"]), l: Number(d["3. low"]), c: Number(d["4. close"]), v: Number(d["5. volume"]) },
      }))
      .sort((a, b) => a.bar.t - b.bar.t);
    deps.onDaily?.(instrumentKey(i), days);
    return days;
  };

  return {
    id: "alphavantage",
    label: "Alpha Vantage (end of day)",
    covers: (i) => i.exchange in SUFFIX,
    async quotes(list, signal) {
      const out: Quote[] = [];
      for (const i of list) {
        const days = await daily(i, false, signal);
        const last = days.at(-1);
        if (!last) continue;
        out.push({
          key: instrumentKey(i),
          price: last.bar.c,
          prevClose: days.at(-2)?.bar.c ?? null,
          at: etInstant(last.date, "16:00"),
          source: "alphavantage",
          freshness: "eod",
        });
      }
      return out;
    },
    async bars(i, tf, from, to, signal) {
      if (tf !== "1Day") throw new ProviderError("no_history", "Alpha Vantage's free plan only has end-of-day prices, so there's no intraday chart for Canadian stocks.");
      // ~252 sessions a year, so 100 sessions is about 145 calendar days.
      const full = now() - from > (COMPACT_SESSIONS * 365 * DAY_MS) / 252;
      const fromSec = from / 1000;
      const toSec = to / 1000;
      return (await daily(i, full, signal)).map((d) => d.bar).filter((b) => b.t >= fromSec && b.t <= toSec);
    },
    async validate() {
      await daily({ symbol: "SHOP", exchange: "TSX" }, false);
    },
  };
}
