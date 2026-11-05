import { expect, test } from "bun:test";
import { pctText, perfRow, sourceTone } from "../../src/dashboard/investing";
import type { PerfResult } from "../../src/engine/markets/performance";

test("source tones map onto the freshness badges", () => {
  expect(sourceTone("official")).toBe("live");
  expect(sourceTone("entered")).toBe("live");
  expect(sourceTone("live")).toBe("live");
  expect(sourceTone("estimate")).toBe("estimate");
  expect(sourceTone("delayed")).toBe("delayed");
  expect(sourceTone("demo")).toBe("demo");
  expect(sourceTone("none")).toBe("none");
});

test("percent text", () => {
  expect(pctText(44.234)).toBe("44.2%");
  expect(pctText(-3.06)).toBe("−3.1%");
  expect(pctText(null)).toBe("n/a");
});

test("a performance row explains an n/a", () => {
  const r: PerfResult = {
    period: "1Y",
    start: "2025-11-05",
    end: "2026-11-05",
    portfolioPct: 12.34,
    benchmarks: [
      { key: "SPY", pct: 18.2, reason: null },
      { key: "XEQT.TO", pct: null, reason: "n/a: Atrium has 100 days of XEQT.TO closes" },
    ],
    basis: "price",
    missing: [],
    note: "Current holdings as if held for the whole period, in CAD at Bank of Canada rates.",
  };
  const row = perfRow(r);
  expect(row).toMatchObject({ label: "1Y", you: "+12.3%", spy: "+18.2%", xeqt: "n/a" });
  expect(row.title).toContain("n/a: Atrium has 100 days of XEQT.TO closes");
  expect(row.title).toContain("price");
});

test("sortRows puts nulls last in both directions and sorts sourced values by value", async () => {
  const { sortRows } = await import("../../src/dashboard/investing");
  const { applyFilters } = await import("../../src/engine/markets/screen");
  const rows = [
    { key: "A", pe: { value: 30, source: "x", asOf: 0, tone: "delayed" as const }, rsi14: null as number | null },
    { key: "B", pe: null, rsi14: 25 },
    { key: "C", pe: { value: 10, source: "x", asOf: 0, tone: "delayed" as const }, rsi14: 70 },
  ];
  expect(sortRows(rows, "pe", "asc").map((r) => r.key)).toEqual(["C", "A", "B"]);
  expect(sortRows(rows, "pe", "desc").map((r) => r.key)).toEqual(["A", "C", "B"]);
  expect(sortRows(rows, "rsi14", "desc").map((r) => r.key)).toEqual(["C", "B", "A"]);
  expect(sortRows(rows, "key", "desc").map((r) => r.key)).toEqual(["C", "B", "A"]);
  const screen = rows.map((r) => ({ ...r, name: r.key, price: null, pos52: null, fromHighPct: null, divYield: null, held: false, stage: "watching" as const, range52Source: null }));
  expect(applyFilters(screen, [{ field: "pe", max: 20 }]).map((r) => r.key)).toEqual(["C"]);
});

test("the day a change is for reads today or names the session", async () => {
  const { dayText } = await import("../../src/dashboard/investing");
  expect(dayText("2026-11-06", Date.parse("2026-11-06T18:00:00Z"))).toBe("today");
  expect(dayText("2026-11-06", Date.parse("2026-11-07T18:00:00Z"))).toBe("on Fri, Nov 6");
  expect(dayText(null, Date.now())).toBe("today");
});
