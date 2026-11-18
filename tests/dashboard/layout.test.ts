import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(import.meta.dir, "..", "..", "src", "dashboard", "styles.css"), "utf8");
const rule = (selector: string) => css.match(new RegExp(`(^|\\n)${selector.replace(/[.*]/g, "\\$&")} \\{([^}]*)\\}`))?.[2] ?? "";

test("the ask bar is docked under the page, so it never covers what's being read", () => {
  // A band at the bottom of the column, not a box floating over the content.
  expect(rule(".cmd-dock")).toContain("position: sticky");
  expect(rule(".cmd-dock")).toContain("bottom: 0");
  expect(rule(".cmd")).not.toContain("position: fixed");
  // Scrolling something into view stops above the band.
  expect(rule("main")).toContain("scroll-padding-bottom: var(--cmd-clear)");
  expect(Number(rule(":root").match(/--cmd-clear:\s*(\d+)px/)?.[1])).toBeGreaterThanOrEqual(10 + 48 + 14);
});

test("no rule sets a display on every input in the ask bar, which would show its hidden file picker", () => {
  // Any selector list holding a bare `.cmd input` must not carry a display.
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selectors = m[1]!.split(",").map((s) => s.trim());
    if (selectors.includes(".cmd input")) expect(m[2]).not.toMatch(/display\s*:/);
  }
});

test("a long dialog scrolls inside itself and keeps its buttons on screen in a short window", () => {
  expect(rule(".dialog")).toContain("max-height: calc(100dvh - 48px)");
  expect(rule(".dialog")).toContain("overflow-y: auto");
  expect(rule(".dialog-acts")).toContain("position: sticky");
  expect(rule(".dialog-acts")).toContain("background: var(--panel)");
});
