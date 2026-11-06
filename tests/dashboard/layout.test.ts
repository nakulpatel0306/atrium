import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(import.meta.dir, "..", "..", "src", "dashboard", "styles.css"), "utf8");
const rule = (selector: string) => css.match(new RegExp(`(^|\\n)${selector.replace(/[.*]/g, "\\$&")} \\{([^}]*)\\}`))?.[2] ?? "";

test("the floating command bar never covers the end of a page or something scrolled into view", () => {
  // The bar's footprint: its distance from the bottom plus its own height.
  const clear = rule(":root").match(/--cmd-clear:\s*(\d+)px/)?.[1];
  expect(Number(clear)).toBeGreaterThanOrEqual(20 + 48 + 16);
  expect(rule("main")).toContain("scroll-padding-bottom: var(--cmd-clear)");
  expect(rule(".wrap")).toMatch(/padding: \d+px \d+px calc\(var\(--cmd-clear\) \+ \d+px\)/);
});
