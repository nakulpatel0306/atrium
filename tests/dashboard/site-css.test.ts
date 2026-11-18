// Every custom property the site uses is defined somewhere it loads. A var() with no definition makes its whole
// declaration invalid, so a padding shorthand with one silently becomes 0 on every side.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SITE = join(import.meta.dir, "..", "..", "site");
const files = readdirSync(SITE).filter((f) => /\.(css|html)$/.test(f));
const text = files.map((f) => readFileSync(join(SITE, f), "utf8")).join("\n");

test("no site CSS uses a custom property that's never defined", () => {
  const defined = new Set([...text.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]!));
  // A var() with a fallback still works without a definition.
  const used = new Set([...text.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)].map((m) => m[1]!));
  expect([...used].filter((v) => !defined.has(v))).toEqual([]);
});
