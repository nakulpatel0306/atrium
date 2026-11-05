import { expect, test } from "bun:test";
import { money, signedPct } from "../../src/dashboard/format";
import { briefingMarketsLine, dayPct, freshnessLabel, holdingTotals } from "../../src/dashboard/markets";
import { describeRule, type AlertRule } from "../../src/engine/markets/labels";
import { parseRoute } from "../../src/dashboard/route";
import type { Quote } from "../../src/engine/markets/providers/types";

const q = (extra: Partial<Quote>): Quote => ({ key: "AAPL", price: 100, prevClose: 99, at: Date.parse("2026-11-04T21:00:00Z"), source: "alpaca", freshness: "live", ...extra });

test("freshnessLabel", () => {
  const nov4close = Date.parse("2026-11-04T21:00:00Z");
  expect(freshnessLabel(q({}), null, nov4close + 60_000)).toEqual({ text: "Alpaca · IEX real-time", tone: "live" });
  expect(freshnessLabel(q({}), null, Date.parse("2026-11-07T15:00:00Z"))).toEqual({ text: "Alpaca · close of Nov 4", tone: "delayed" });
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

test("briefingMarketsLine: one investing line, then paper", () => {
  const nov4 = Date.parse("2026-11-04T21:00:00Z");
  const holdings = [{ key: "SHOP.TO", dayPct: 2.1, freshness: "eod" as const, asOf: nov4 }];
  const day = { dayPct: 0.8, dayCad: 412.4, mix: "Finnhub · real-time", tone: "live" as const, closes: 0, dayLabel: "today", movers: [{ key: "RKLB", dayPct: 6.1, tag: null }], headline: "Rocket Lab wins NASA contract" };
  expect(briefingMarketsLine({ paper: null, holdings, portfolio: day })).toBe('Portfolio +0.8% today (+CA$412) · RKLB +6.1%: "Rocket Lab wins NASA contract"');
  const mixed = { ...day, mix: "10 real-time · 3 close of Nov 4", tone: "delayed" as const, closes: 3, headline: null };
  expect(briefingMarketsLine({ paper: null, holdings, portfolio: mixed })).toBe("Portfolio +0.8% today (+CA$412) · mixed: 3 at last close · RKLB +6.1%");
  const down = { ...day, dayPct: -1.25, dayCad: -98.6, headline: null, movers: [{ key: "QBTS", dayPct: -4.2, tag: null }] };
  expect(briefingMarketsLine({ paper: { dayPnl: 12, totalPnl: -40, equity: 9960 }, holdings, portfolio: down })).toBe("Portfolio −1.3% today (−CA$99) · QBTS −4.2% · Paper +$12.00 today");
  expect(briefingMarketsLine({ paper: { dayPnl: 12, totalPnl: -40, equity: 9960 }, holdings, portfolio: null })).toBe("Paper +$12.00 today");
  expect(briefingMarketsLine({ paper: null, holdings, portfolio: null })).toBeNull();
  expect(briefingMarketsLine({ paper: null, holdings, portfolio: { ...day, dayLabel: "on Fri, Nov 6", headline: null } })).toBe("Portfolio +0.8% on Fri, Nov 6 (+CA$412) · RKLB +6.1%");
  const demo = { ...day, mix: "Demo data", tone: "demo" as const, headline: null, movers: [{ key: "RKLB", dayPct: 6.1, tag: "demo" }] };
  expect(briefingMarketsLine({ paper: null, holdings, portfolio: demo })).toBe("Portfolio +0.8% today (+CA$412) · demo data · RKLB +6.1%");
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
