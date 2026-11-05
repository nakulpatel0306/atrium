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
