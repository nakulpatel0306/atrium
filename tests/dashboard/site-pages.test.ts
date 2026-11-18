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
    // Links people click are fine, and so is a canonical link, which names the page without fetching it; anything the
    // browser fetches by itself is not.
    for (const m of text.matchAll(/<(?:link|script|img|source|iframe)\b[^>]*\b(?:href|src)="(https?:)?\/\/[^"]*"/g)) {
      if (!m[0].startsWith('<link rel="canonical"')) outside.push(`${f}: ${m[0]}`);
    }
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

const FOOTER = ["index.html", "terminal.html", "notes.html", "privacy.html", "terms.html", "security.html"];

test("every page's footer links Privacy, Terms and Security beside the rest of the site", () => {
  for (const page of [...pages, "privacy.html", "terms.html", "security.html"]) {
    expect({ page, exists: existsSync(join(SITE, page)) }).toEqual({ page, exists: true });
    const footer = read(page).match(/<footer>[\s\S]*?<\/footer>/)?.[0] ?? "";
    const links = [...footer.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect({ page, links: FOOTER.every((f) => links.includes(f)) }).toEqual({ page, links: true });
  }
});

test("the policy pages are titled like the rest of the site", () => {
  for (const [page, name] of [["privacy.html", "Privacy"], ["terms.html", "Terms"], ["security.html", "Security"]] as const) {
    expect(read(page)).toContain(`<title>Atrium · ${name}</title>`);
  }
});

test("every page has a description and names its one canonical address", () => {
  expect(pages.length).toBe(19);
  for (const page of pages) {
    const head = read(page).slice(0, read(page).indexOf("</head>"));
    const url = `https://nakulpatel0306.github.io/atrium/${page === "index.html" ? "" : page}`;
    expect({ page, description: /<meta name="description" content="[^"]{60,}">/.test(head) }).toEqual({ page, description: true });
    expect({ page, canonical: head.match(/<link rel="canonical" href="([^"]*)">/g) }).toEqual({ page, canonical: [`<link rel="canonical" href="${url}">`] });
  }
});

test("the landing page's privacy section leads to the privacy and security pages", () => {
  const section = read("index.html").match(/<section class="private"[\s\S]*?<\/section>/)?.[0] ?? "";
  expect(section).toContain('href="privacy.html"');
  expect(section).toContain('href="security.html"');
});

test("the security page points to the repo's SECURITY.md and to private reporting on GitHub", () => {
  expect(existsSync(join(SITE, "..", "SECURITY.md"))).toBe(true);
  const html = read("security.html");
  expect(html).toContain("https://github.com/nakulpatel0306/atrium/blob/main/SECURITY.md");
  expect(html).toContain("https://github.com/nakulpatel0306/atrium/security/advisories/new");
});

test("every link between the site's pages lands on a page that exists, and on a section that exists", () => {
  const broken: string[] = [];
  for (const page of pages) {
    // Same-site links only: no scheme, so not https:, mailto: and the like.
    for (const [, href] of read(page).matchAll(/href="([^":]+)"/g)) {
      const [file, hash] = href!.split("#") as [string, string | undefined];
      if (file && !file.endsWith(".html")) continue;
      const target = file || page;
      if (!existsSync(join(SITE, target)) || (hash && !read(target).includes(`id="${hash}"`))) broken.push(`${page} → ${href}`);
    }
  }
  expect(broken).toEqual([]);
});
