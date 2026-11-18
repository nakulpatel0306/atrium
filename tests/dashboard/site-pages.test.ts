// The site's pages as files: what they load, and the links every page carries.
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SITE = join(import.meta.dir, "..", "..", "site");
const pages = readdirSync(SITE).filter((f) => f.endsWith(".html"));
const read = (f: string) => readFileSync(join(SITE, f), "utf8");

test("no page loads anything from another site: fonts, scripts and styles are all served with the pages", () => {
  const sources = [...pages, ...readdirSync(SITE).filter((f) => f.endsWith(".css"))];
  const outside: string[] = [];
  for (const f of sources) {
    const text = read(f);
    // Links people click are fine; anything the browser fetches by itself is not.
    for (const m of text.matchAll(/<(?:link|script|img|source|iframe)\b[^>]*\b(?:href|src)="(https?:)?\/\/[^"]*"/g)) outside.push(`${f}: ${m[0]}`);
    for (const m of text.matchAll(/url\(\s*["']?(?:https?:)?\/\/[^)]*\)|@import\b[^;]*/g)) outside.push(`${f}: ${m[0]}`);
  }
  expect(outside).toEqual([]);
});

test("Inter Tight and Geist Mono are served from site/vendor, each with its licence beside it", () => {
  const css = read("site.css");
  const faces = css.match(/@font-face\s*{[^}]*}/g) ?? [];
  const vendor = readdirSync(join(SITE, "vendor"));
  for (const family of ["Inter Tight", "Geist Mono"]) {
    const face = faces.find((f) => f.includes(`font-family: "${family}";`)) ?? "";
    expect({ family, weights: face.includes("font-weight: 100 900;") }).toEqual({ family, weights: true });
    const src = face.match(/url\("(vendor\/[^"]+\.woff2)"\)/)?.[1];
    expect({ family, src: !!src && existsSync(join(SITE, src)) }).toEqual({ family, src: true });
    expect(statSync(join(SITE, src!)).size).toBeLessThan(400 * 1024);
    const stem = src!.slice("vendor/".length).split("-latin")[0]!;
    expect({ family, license: vendor.some((v) => v.startsWith(stem) && /LICENSE/.test(v)) }).toEqual({ family, license: true });
  }
  expect(read("vendor/README.md")).toContain("SIL Open Font License");
});
