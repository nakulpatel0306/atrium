import { expect, test } from "bun:test";
import { money, signedPct } from "../../src/dashboard/format";
import { dayPct, freshnessLabel } from "../../src/dashboard/markets";
import { parseRoute } from "../../src/dashboard/route";
import type { Quote } from "../../src/engine/markets/providers/types";

const q = (extra: Partial<Quote>): Quote => ({ key: "AAPL", price: 100, prevClose: 99, at: Date.parse("2026-11-04T21:00:00Z"), source: "alpaca", freshness: "live", ...extra });

test("freshnessLabel", () => {
  expect(freshnessLabel(q({}), null)).toEqual({ text: "IEX real-time", tone: "live" });
  expect(freshnessLabel(q({ freshness: "eod", source: "alphavantage" }), null)).toEqual({ text: "Delayed · close of Nov 4", tone: "delayed" });
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
