import type { Database } from "bun:sqlite";
import { saveQuotes } from "../../../src/engine/markets/cache";
import { etInstant } from "../../../src/engine/markets/calendar";
import { recordCloses } from "../../../src/engine/markets/closes";
import type { MarketData } from "../../../src/engine/markets/data";
import { saveFx } from "../../../src/engine/markets/fx";
import { addHolding } from "../../../src/engine/markets/holdings";
import type { Instrument } from "../../../src/engine/markets/instrument";
import { ensureDefaultList, addToList } from "../../../src/engine/markets/lists";
import type { MarketProvider } from "../../../src/engine/markets/providers/types";
import { createSpace } from "../../../src/engine/spaces";

// Thu Nov 5 2026, 10:00 ET: in session; the last completed session is Wed Nov 4.
export const NOW = Date.parse("2026-11-05T15:00:00Z");
export const NOV4_CLOSE = etInstant("2026-11-04", "16:00");
export const FX = 1.3961;

// Only what the views read: which provider prices each listing (cached quotes must match it) and why not.
export function viewData(over: Partial<MarketData> = {}): MarketData {
  const finnhub = { id: "finnhub", label: "Finnhub" } as MarketProvider;
  const av = { id: "alphavantage", label: "Alpha Vantage" } as MarketProvider;
  return {
    providerFor: (i: Instrument) => (i.exchange === "US" ? finnhub : i.exchange === "TSX" || i.exchange === "TSXV" ? av : null),
    reasonFor: (i: Instrument) => (i.exchange === "NEO" ? "No free source covers NEO-listed CDRs." : null),
    secrets: () => [],
    ...over,
  } as MarketData;
}

// Holdings AMZN × 10 (USD, book 1,500) and XEQT.TO × 100 (CAD); AMZN live at 250 (prev 245), XEQT at Nov 4's close.
export function simpleFixture(db: Database) {
  const spaceId = createSpace(db, { name: "Investing", kind: "markets", goal: "g", private: true }).id;
  addHolding(db, spaceId, { account: "TFSA", symbol: "AMZN", exchange: "US", name: "Amazon", quantity: 10, bookValue: 1500, currency: "USD" });
  addHolding(db, spaceId, { account: "TFSA", symbol: "XEQT", exchange: "TSX", name: "iShares Core Equity ETF Portfolio", quantity: 100, bookValue: 3000, currency: "CAD" });
  saveQuotes(db, [
    { key: "AMZN", price: 250, prevClose: 245, at: NOW, source: "finnhub", freshness: "live" },
    { key: "XEQT.TO", price: 35, prevClose: 34.9, at: NOV4_CLOSE, source: "alphavantage", freshness: "eod" },
  ]);
  saveFx(db, [{ date: "2026-11-03", rate: 1.39 }, { date: "2026-11-04", rate: FX }]);
  // The 30 weekdays up to Nov 4.
  const days: string[] = [];
  for (let d = Date.parse("2026-11-04T12:00:00Z"); days.length < 30; d -= 86_400_000) {
    const wd = new Date(d).getUTCDay();
    if (wd !== 0 && wd !== 6) days.unshift(new Date(d).toISOString().slice(0, 10));
  }
  recordCloses(db, "AMZN", days.map((date, n) => ({ date, close: 200 + n, adjClose: 200 + n, source: "tiingo" })));
  const holdings = ensureDefaultList(db, spaceId);
  for (const k of ["AMZN", "XEQT"]) addToList(db, holdings.id, { symbol: k, exchange: k === "AMZN" ? "US" : "TSX" });
  return { spaceId, holdingsList: holdings.id };
}
