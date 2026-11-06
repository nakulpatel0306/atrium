import { expect, test } from "bun:test";
import { contrastFailures, ratio, tokens } from "../copy/contrast";
import { readBaseline } from "../copy/rules";

test("contrast math matches WCAG", () => {
  expect(ratio("#ffffff", "#000000")).toBeCloseTo(21, 5);
  expect(tokens()["--bg"]).toMatch(/^#/);
});

test("every text token is readable on every surface", () => {
  // Until the copy pass raises --faint, the baseline records the failure; it must be fixed, not grow.
  const allowed = readBaseline()["src/dashboard/styles.css"]?.contrast ?? 0;
  expect(contrastFailures().length).toBeLessThanOrEqual(allowed);
  if (!allowed) expect(contrastFailures()).toEqual([]);
});
