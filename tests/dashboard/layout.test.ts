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
