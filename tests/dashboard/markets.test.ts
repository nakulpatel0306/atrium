import { expect, test } from "bun:test";
import { money, signedPct } from "../../src/dashboard/format";
import { briefingMarketsLine, dayPct, freshnessLabel, holdingTotals } from "../../src/dashboard/markets";
import { describeRule, type AlertRule } from "../../src/engine/markets/labels";
import { parseRoute } from "../../src/dashboard/route";
import type { Quote } from "../../src/engine/markets/providers/types";

const q = (extra: Partial<Quote>): Quote => ({ key: "AAPL", price: 100, prevClose: 99, at: Date.parse("2026-11-04T21:00:00Z"), source: "alpaca", freshness: "live", ...extra });

test("freshnessLabel", () => {
  expect(freshnessLabel(q({}), null)).toEqual({ text: "Alpaca · IEX real-time", tone: "live" });
  expect(freshnessLabel(q({ freshness: "eod", source: "alphavantage" }), null)).toEqual({ text: "Alpha Vantage · close of Nov 4", tone: "delayed" });
  expect(freshnessLabel(q({ freshness: "demo", source: "demo" }), null)).toEqual({ text: "Demo data", tone: "demo" });
  expect(freshnessLabel(null, "No free source covers NEO-listed CDRs.")).toEqual({ text: "No live data: No free source covers NEO-listed CDRs.", tone: "none" });
});

test("dayPct", () => {
  expect(dayPct(q({ prevClose: null }))).toBeNull();
  expect(dayPct(q({ price: 110, prevClose: 100 }))!).toBeCloseTo(10, 6);
});

test("money and signedPct", () => {
  expect(money(1234.5, "CAD")).toBe("CA$1,234.50");
  expect(money(-3, "USD")).toBe("−$3.00");
  expect(signedPct(2.1)).toBe("+2.10%");
  expect(signedPct(-0.8, 1)).toBe("−0.8%");
});

test("settings route", () => {
  expect(parseRoute("/settings")).toEqual({ name: "settings" });
});

test("briefingMarketsLine", () => {
  const nov4 = Date.parse("2026-11-04T21:00:00Z");
  const holdings = [
    { key: "SHOP.TO", dayPct: 2.1, freshness: "eod" as const, asOf: nov4 },
    { key: "AAPL", dayPct: -0.8, freshness: "live" as const, asOf: nov4 },
  ];
  expect(briefingMarketsLine({ paper: { dayPnl: 12.3, totalPnl: -40, equity: 9960 }, holdings })).toBe(
    "Paper +$12.30 today (−$40.00 total) · Your holdings: SHOP.TO +2.1% (close Nov 4), AAPL −0.8%",
  );
  expect(briefingMarketsLine({ paper: null, holdings })).toBe("Your holdings: SHOP.TO +2.1% (close Nov 4), AAPL −0.8%");
  expect(briefingMarketsLine({ paper: { dayPnl: 0, totalPnl: 0, equity: 10000 }, holdings: [] })).toBe("Paper +$0.00 today (+$0.00 total)");
  expect(briefingMarketsLine({ paper: null, holdings: [] })).toBeNull();
  expect(briefingMarketsLine({ paper: null, holdings: [{ key: "KO", dayPct: 1, freshness: "demo", asOf: nov4 }] })).toBe("Your holdings: KO +1.0% (demo)");
});

test("describeRule copy for every alert kind", () => {
  const rules: [AlertRule, string][] = [
    [{ kind: "price_above", level: 200 }, "price above $200.00"],
    [{ kind: "price_below", level: 50 }, "price below $50.00"],
    [{ kind: "pct_move", pct: 5 }, "moves 5% in a day"],
    [{ kind: "rsi_below", level: 30, period: 14 }, "RSI(14) below 30"],
    [{ kind: "rsi_above", level: 70, period: 14 }, "RSI(14) above 70"],
    [{ kind: "cross_above_sma", period: 50 }, "crosses above SMA 50"],
    [{ kind: "cross_below_sma", period: 20 }, "crosses below SMA 20"],
  ];
  for (const [rule, text] of rules) expect(describeRule(rule)).toBe(text);
});

test("holding totals keep market value in the listing's currency and book value in the entered one", () => {
  const h = (key: string, currency: "CAD" | "USD", quantity: number, price: number, bookValue: number) =>
    ({ key, currency, quantity, bookValue, quote: { key, price, prevClose: price - 1, at: 0, source: "demo", freshness: "demo" } }) as Parameters<typeof holdingTotals>[0][number];
  // A US stock whose book value was typed in CAD.
  const totals = holdingTotals([h("AAPL", "CAD", 2, 100, 250), h("SHOP.TO", "CAD", 1, 50, 40)]);
  expect(totals.value).toEqual({ USD: 200, CAD: 50 });
  expect(totals.day).toEqual({ USD: 2, CAD: 1 });
  expect(totals.book).toEqual({ CAD: 290 });
});
