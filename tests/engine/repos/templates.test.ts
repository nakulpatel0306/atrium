import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEMPLATE_LABELS, templateFiles, writeTemplate } from "../../../src/engine/repos/templates";

let base: string;
let dir: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "atrium-tpl-"));
  dir = join(base, "proj");
  mkdirSync(dir);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const d = { name: "Demo", description: "A demo app" };

test("labels", () => {
  expect(TEMPLATE_LABELS).toEqual({ "bun-ts": "bun + TypeScript", empty: "Empty" });
});

test("writeTemplate writes every bun-ts file", () => {
  const files = templateFiles("bun-ts", d);
  expect(Object.keys(files).sort()).toEqual([".gitignore", "CLAUDE.md", "README.md", "package.json", "src/index.test.ts", "src/index.ts", "tsconfig.json"]);
  writeTemplate(dir, files);
  for (const [rel, body] of Object.entries(files)) expect(readFileSync(join(dir, rel), "utf8")).toBe(body);
  expect(files[".gitignore"]).toContain(".env*");
  expect(JSON.parse(files["package.json"]!).name).toBe("demo");
  expect(files["README.md"]).toBe("# Demo\n\nA demo app\n\n## Run\n\nbun install\nbun test\n");
});

test("the empty template has only the basics", () => {
  expect(Object.keys(templateFiles("empty", d)).sort()).toEqual([".gitignore", "CLAUDE.md", "README.md"]);
});

test("no template file carries Claude attribution", () => {
  for (const id of ["bun-ts", "empty"] as const) {
    for (const body of Object.values(templateFiles(id, d))) {
      expect(body).not.toContain("Co-Authored-By");
      expect(body).not.toContain("Generated with");
    }
  }
});

test("paths that escape the folder throw and write nothing outside it", () => {
  const bads: Record<string, string>[] = [{ "../evil": "x" }, { [join(base, "abs")]: "x" }, { "a/../../b": "x" }];
  for (const bad of bads) {
    expect(() => writeTemplate(dir, bad)).toThrow();
  }
  expect(readdirSync(base).sort()).toEqual(["proj"]);
  expect(readdirSync(dir)).toEqual([]);
});

test("an existing file is never overwritten", () => {
  writeFileSync(join(dir, "README.md"), "mine");
  expect(() => writeTemplate(dir, { "README.md": "theirs" })).toThrow();
  expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("mine");
});

test("a symlinked subfolder throws", () => {
  const outside = join(base, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(dir, "src"));
  expect(() => writeTemplate(dir, { "src/index.ts": "x" })).toThrow();
  expect(existsSync(join(outside, "index.ts"))).toBe(false);
});
