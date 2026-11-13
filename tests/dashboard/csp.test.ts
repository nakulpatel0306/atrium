import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DASH = resolve(import.meta.dir, "../../src/dashboard");
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'";

test("index.html carries the CSP and loads no Google Fonts", () => {
  const html = readFileSync(join(DASH, "index.html"), "utf8");
  expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${CSP}" />`);
  expect(html).not.toContain("fonts.googleapis");
  expect(html).not.toContain("fonts.gstatic");
});

test("Inter is self-hosted", () => {
  const css = readFileSync(join(DASH, "styles.css"), "utf8");
  const face = css.match(/@font-face\s*{[^}]*}/)?.[0] ?? "";
  expect(face).toContain("font-family: Inter;");
  expect(face).toContain("font-weight: 100 900;");
  const src = face.match(/url\("\.\/(assets\/fonts\/[^"]+\.woff2)"\)/)?.[1];
  expect(src).toBeDefined();
  const file = join(DASH, src!);
  expect(existsSync(file)).toBe(true);
  expect(statSync(file).size).toBeLessThan(400 * 1024);
  expect(existsSync(join(DASH, "assets/fonts/LICENSE-Inter.txt"))).toBe(true);
});

// Loopback URLs (and ones built from the page's own location) are fine. Libraries carry documentation links in their error messages; none is
// loaded. Anything else in the bundle would be new external content.
const LIBRARY_LINKS = /^https?:\/\/(react\.dev|reactjs\.org|github\.com|developer\.mozilla\.org|bugs\.webkit\.org|www\.apache\.org|www\.w3\.org)/;

test("the bundle has no inline script and loads nothing external", async () => {
  const out = mkdtempSync(join(tmpdir(), "atrium-bundle-"));
  try {
    const r = await Bun.build({ entrypoints: [join(DASH, "index.html")], outdir: out });
    expect(r.success).toBe(true);
    const files = readdirSync(out, { recursive: true }).map(String);
    const html = files.filter((f) => f.endsWith(".html")).map((f) => readFileSync(join(out, f), "utf8")).join("\n");
    for (const tag of html.match(/<script\b[^>]*>/g) ?? []) expect(tag).toMatch(/\ssrc=/);
    const text = files.filter((f) => /\.(js|css|html)$/.test(f)).map((f) => readFileSync(join(out, f), "utf8")).join("\n");
    const urls = [...new Set(text.match(/https?:\/\/[^\s"'`)<>\\]+/g) ?? [])].filter((u) => !/^https?:\/\/(127\.0\.0\.1|localhost|\$\{)/.test(u));
    expect(urls.filter((u) => !LIBRARY_LINKS.test(u))).toEqual([]);
    expect(text).not.toContain("tradingview-widget");
    expect(text).not.toContain("s3.tradingview.com");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
