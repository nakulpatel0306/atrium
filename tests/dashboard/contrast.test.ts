import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contrastFailures, ratio, tokens } from "../copy/contrast";

test("contrast math matches WCAG", () => {
  expect(ratio("#ffffff", "#000000")).toBeCloseTo(21, 5);
  expect(tokens()["--bg"]).toMatch(/^#/);
});

test("every text token is readable on every surface", () => {
  expect(contrastFailures()).toEqual([]);
});

test("the Mac's light setting and the picked light theme use the same tokens", () => {
  const css = readFileSync(join(import.meta.dir, "..", "..", "src", "dashboard", "styles.css"), "utf8");
  const body = (re: RegExp) => css.match(re)![1]!.replace(/\s+/g, " ").trim();
  expect(body(/:root:not\(\[data-theme="dark"\]\)\s*{([^}]*)}/)).toBe(body(/:root\[data-theme="light"\]\s*{([^}]*)}/));
});
