import { expect, test } from "bun:test";
import type { Close } from "../../../src/engine/markets/closes";
import { performance, periodStart } from "../../../src/engine/markets/performance";

const TODAY = "2026-11-05";
// Weekday dates going back from `end`.
function weekdays(end: string, n: number): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${end}T12:00:00Z`); out.length < n; t -= 86_400_000) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.unshift(d.toISOString().slice(0, 10));
  }
  return out;
}
const series = (dates: string[], from: number, to: number, adj = true): Close[] =>
  dates.map((date, i) => {
    const c = from + ((to - from) * i) / (dates.length - 1);
    return { date, close: c, adjClose: adj ? c : null, source: "tiingo" };
  });
const run = (data: Record<string, Close[]>, holdings: { key: string; quantity: number; listingCcy: "CAD" | "USD" }[], fx: (d: string) => number | null, period: Parameters<typeof performance>[1] = "1M", benchmarks: string[] = []) =>
  performance({ holdings, closes: (k, from) => (data[k] ?? []).filter((c) => c.date >= from), fxOn: fx, today: TODAY }, period, benchmarks);

const month = weekdays(TODAY, 24); // Mon Oct 5 to Thu Nov 5
const fxRamp = (d: string) => (d < month[0]! ? 1.4 : 1.4 + (0.07 * month.indexOf(d)) / (month.length - 1));

test("periods start where they should", () => {
  expect(periodStart("YTD", TODAY)).toBe("2025-12-31");
  expect(periodStart("1M", TODAY)).toBe("2026-10-05");
  expect(periodStart("3M", TODAY)).toBe("2026-08-05");
  expect(periodStart("1Y", TODAY)).toBe("2025-11-05");
  expect(periodStart("1M", "2026-03-31")).toBe("2026-02-28");
});

test("returns are in CAD at the Bank of Canada rate of each date", () => {
  const cad = run({ "XEQT.TO": series(month, 100, 110) }, [{ key: "XEQT.TO", quantity: 1, listingCcy: "CAD" }], () => null);
  expect(cad.portfolioPct!).toBeCloseTo(10, 9);
  const flat = run({ SPY: series(month, 100, 100) }, [{ key: "SPY", quantity: 1, listingCcy: "USD" }], fxRamp);
  expect(flat.portfolioPct!).toBeCloseTo(5, 9);
  const up = run({ SPY: series(month, 100, 110) }, [{ key: "SPY", quantity: 1, listingCcy: "USD" }], fxRamp);
  expect(up.portfolioPct!).toBeCloseTo(15.5, 9);
  expect(up.basis).toBe("total return");
  expect(up.note).toBe("Current holdings as if held for the whole period, in CAD at Bank of Canada rates.");
  expect([up.start, up.end]).toEqual(["2026-10-05", TODAY]);
});

test("short history is n/a, not shortened", () => {
  const xeqt = series(weekdays(TODAY, 100), 30, 36);
  const r = run({ "XEQT.TO": xeqt, SPY: series(weekdays(TODAY, 260), 500, 600) }, [{ key: "SPY", quantity: 1, listingCcy: "USD" }], () => 1.4, "1Y", ["SPY", "XEQT.TO"]);
  expect(r.benchmarks.find((b) => b.key === "XEQT.TO")).toEqual({ key: "XEQT.TO", pct: null, reason: "n/a: Atrium has 100 days of XEQT.TO closes" });
  expect(r.benchmarks.find((b) => b.key === "SPY")!.pct!).toBeCloseTo(20, 1);
  const p = run({ "XEQT.TO": xeqt, SPY: series(weekdays(TODAY, 260), 500, 600) }, [{ key: "SPY", quantity: 1, listingCcy: "USD" }, { key: "XEQT.TO", quantity: 100, listingCcy: "CAD" }], () => 1.4, "1Y");
  expect(p.missing).toEqual([{ key: "XEQT.TO", reason: "n/a: Atrium has 100 days of XEQT.TO closes" }]);
  // XEQT is 3,600 of 4,440 CAD today, far over a tenth, so there's no portfolio number.
  expect(p.portfolioPct).toBeNull();
});

test("one series without adjusted closes makes it a price return", () => {
  const r = run({ SPY: series(month, 100, 110), "XEQT.TO": series(month, 30, 33, false) }, [{ key: "SPY", quantity: 1, listingCcy: "USD" }, { key: "XEQT.TO", quantity: 1, listingCcy: "CAD" }], () => 1.4);
  expect(r.basis).toBe("price");
  expect(r.portfolioPct!).toBeCloseTo(((110 * 1.4 + 33) / (100 * 1.4 + 30) - 1) * 100, 9);
});
