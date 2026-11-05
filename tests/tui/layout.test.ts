import { expect, test } from "bun:test";
import { layout } from "../../src/tui/layout";
import type { ListPane, Pane } from "../../src/tui/ui";

const PANES: Pane[] = ["spaces", "tasks", "needs", "activity", "detail", "live"];

test("heights add up and nobody vanishes", () => {
  for (let rows = 24; rows <= 60; rows++) {
    for (const focus of PANES) {
      const lastLeft: ListPane = focus === "detail" || focus === "live" ? "needs" : focus;
      const l = layout(120, rows, focus, lastLeft);
      if ("tooSmall" in l) throw new Error(`too small at ${rows}`);
      const hs = Object.values(l.heights);
      expect(hs.reduce((a, b) => a + b, 0)).toBe(rows - 2);
      for (const h of hs) expect(h).toBeGreaterThanOrEqual(3);
      expect(Math.max(...hs)).toBe(l.heights[lastLeft]);
      expect(hs.filter((h) => h === l.heights[lastLeft])).toHaveLength(1);
      expect(l.detail + l.live).toBe(rows - 2);
      expect(l.left + l.right).toBe(120);
    }
  }
  expect(layout(79, 30, "spaces", "spaces")).toEqual({ tooSmall: true });
  expect(layout(100, 23, "spaces", "spaces")).toEqual({ tooSmall: true });
});

test("the left column stays readable", () => {
  const narrow = layout(80, 24, "spaces", "spaces");
  const wide = layout(300, 40, "spaces", "spaces");
  expect("tooSmall" in narrow ? 0 : narrow.left).toBe(32);
  expect("tooSmall" in wide ? 0 : wide.left).toBe(60);
});
