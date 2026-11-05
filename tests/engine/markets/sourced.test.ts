import { expect, test } from "bun:test";
import { freshnessText } from "../../../src/engine/markets/labels";
import type { Quote } from "../../../src/engine/markets/providers/types";
import { closeDayText, fxLabel, mixLabel, quoteSourced, toCad, type Sourced } from "../../../src/engine/markets/sourced";

const closeNov4 = Date.parse("2026-11-04T21:00:00Z"); // 16:00 ET
const q = (extra: Partial<Quote>): Quote => ({ key: "AAPL", price: 100, prevClose: 99, at: closeNov4, source: "finnhub", freshness: "live", ...extra });
const fx: Sourced = { value: 1.3961, source: "Bank of Canada · Nov 4", asOf: Date.parse("2026-11-04T21:30:00Z"), tone: "official" };

test("freshnessText names the provider and the close", () => {
  expect(freshnessText(q({}))).toBe("Finnhub · real-time");
  expect(freshnessText(q({ source: "alpaca" }))).toBe("Alpaca · IEX real-time");
  expect(freshnessText(q({ source: "alphavantage", freshness: "eod" }))).toBe("Alpha Vantage · close of Nov 4");
  expect(freshnessText(q({ source: "tiingo", freshness: "eod" }))).toBe("Tiingo · close of Nov 4");
  expect(freshnessText(q({ source: "demo", freshness: "demo" }))).toBe("Demo data");
});

test("quoteSourced labels an Alpha Vantage close as delayed", () => {
  expect(quoteSourced(q({ source: "alphavantage", freshness: "eod", price: 90 }))).toEqual({
    value: 90,
    source: "Alpha Vantage · close of Nov 4",
    asOf: closeNov4,
    tone: "delayed",
  });
  expect(quoteSourced(q({})).tone).toBe("live");
  expect(quoteSourced(q({ source: "demo", freshness: "demo" })).tone).toBe("demo");
});

test("mixLabel says when a total mixes sources", () => {
  const live = Array.from({ length: 10 }, () => quoteSourced(q({})));
  const eod = Array.from({ length: 3 }, () => quoteSourced(q({ source: "alphavantage", freshness: "eod" })));
  expect(mixLabel([...eod, ...live])).toEqual({ text: "10 real-time · 3 close of Nov 4", tone: "delayed" });
  expect(mixLabel(live)).toEqual({ text: "Finnhub · real-time", tone: "live" });
  const est: Sourced = { value: 1, source: "Estimate from SPY × USD/CAD (Bank of Canada Nov 4)", asOf: closeNov4, tone: "estimate" };
  const withEst = mixLabel([...live, est]);
  expect(withEst.tone).toBe("estimate");
  expect(withEst.text.endsWith("· 1 estimate")).toBe(true);
  expect(mixLabel([])).toEqual({ text: "No prices yet", tone: "none" });
});

test("toCad and fxLabel", () => {
  expect(toCad(100, "USD", fx)!).toBeCloseTo(139.61, 9);
  expect(toCad(100, "USD", null)).toBeNull();
  expect(toCad(100, "CAD", null)).toBe(100);
  expect(fxLabel(fx)).toBe("at Bank of Canada USD/CAD 1.3961 (Nov 4)");
  expect(closeDayText(closeNov4)).toBe("Nov 4");
});
