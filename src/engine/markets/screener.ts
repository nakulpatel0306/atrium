import type { Database } from "bun:sqlite";
import { etDate } from "./calendar";
import { closes } from "./closes";
import { currentQuote, type MarketData } from "./data";
import { listHoldings } from "./holdings";
import { listIdeas } from "./ideas";
import { rsi } from "./indicators";
import { parseInstrumentKey } from "./instrument";
import { getMeta } from "./meta";
import type { ScreenRow } from "./screen";
import { closeDayText, quoteSourced, type Sourced } from "./sourced";
import { ttmDividends } from "./tfsa";
import { listWatchlist } from "./watchlist";

export { applyFilters, type ScreenFilter, type ScreenRow } from "./screen";

const YEAR_MS = 365 * 86_400_000;
const FULL_YEAR = 200;
const STORED = "Atrium's stored closes";

// Cache-only: stored closes, cached quotes and stored metrics over the watchlist and holdings.
export function screenRows(db: Database, data: MarketData, spaceId: string, now: number = Date.now()): ScreenRow[] {
  const holdings = listHoldings(db, spaceId);
  const watch = listWatchlist(db, spaceId);
  const names = new Map<string, string>();
  for (const x of [...holdings, ...watch]) if (x.name && !names.has(x.key)) names.set(x.key, x.name);
  const keys = [...new Set([...watch.map((w) => w.key), ...holdings.map((h) => h.key)])];
  const meta = getMeta(db, keys);
  const stages = new Map(listIdeas(db, spaceId).map((i) => [i.key, i.stage]));
  const held = new Set(holdings.map((h) => h.key));
  return keys.map((key) => {
    const q = currentQuote(db, data, parseInstrumentKey(key)!);
    const price = q ? quoteSourced(q) : null;
    const m = meta.get(key);
    const metricsLabel = m?.metricsAt ? `Finnhub · metrics ${closeDayText(m.metricsAt)}` : null;
    const year = closes(db, key, etDate(now - YEAR_MS)).map((c) => c.close);
    let high: number | null = null;
    let low: number | null = null;
    let range52Source: string | null = null;
    if (year.length >= FULL_YEAR) {
      high = Math.max(...year);
      low = Math.min(...year);
      range52Source = STORED;
    } else if (m?.high52 != null && m.low52 != null && metricsLabel) {
      high = m.high52;
      low = m.low52;
      range52Source = metricsLabel;
    }
    const p = price?.value ?? null;
    const pos52 = p !== null && high !== null && low !== null && high > low ? (p - low) / (high - low) : null;
    const fromHighPct = p !== null && high ? (p / high - 1) * 100 : null;
    const series = closes(db, key, "1900-01-01").map((c) => c.close);
    const rsi14 = series.length >= 15 ? rsi(series, 14).at(-1) ?? null : null;
    const ttm = ttmDividends(db, key, now);
    const divYield: Sourced | null =
      ttm > 0 && p
        ? { value: (ttm / p) * 100, source: "Tiingo dividends", asOf: now, tone: "official" }
        : m?.divYield != null && metricsLabel
          ? { value: m.divYield, source: metricsLabel, asOf: m.metricsAt!, tone: "delayed" }
          : null;
    const pe: Sourced | null = m?.pe != null && metricsLabel ? { value: m.pe, source: metricsLabel, asOf: m.metricsAt!, tone: "delayed" } : null;
    return {
      key,
      name: names.get(key) ?? m?.name ?? key,
      price,
      pe,
      pos52,
      fromHighPct,
      rsi14,
      divYield,
      held: held.has(key),
      stage: stages.get(key) ?? (held.has(key) ? "owned" : "watching"),
      range52Source,
    };
  });
}
