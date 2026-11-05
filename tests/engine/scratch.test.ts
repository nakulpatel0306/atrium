import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keepScratch } from "../../src/engine/scratch";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "atrium-scratch-test-"));
  dirs.push(d);
  return d;
};

test("copies files and folders, skips symlinks", () => {
  const src = temp();
  const dest = join(temp(), "runs", "run_1");
  writeFileSync(join(src, "a.txt"), "a");
  mkdirSync(join(src, "d"));
  writeFileSync(join(src, "d", "b.txt"), "b");
  symlinkSync(join(src, "a.txt"), join(src, "link"));
  expect(keepScratch(src, dest)).toEqual({ files: 2, truncated: false });
  expect(readFileSync(join(dest, "d", "b.txt"), "utf8")).toBe("b");
  expect(existsSync(join(dest, "link"))).toBe(false);
});

test("an empty folder keeps nothing and makes no folder", () => {
  const dest = join(temp(), "run");
  expect(keepScratch(temp(), dest)).toEqual({ files: 0, truncated: false });
  expect(existsSync(dest)).toBe(false);
});

test("cuts files at the per-file cap and stops at the per-run cap", () => {
  const src = temp();
  const dest = join(temp(), "run");
  writeFileSync(join(src, "1-big.bin"), Buffer.alloc(30, 1));
  writeFileSync(join(src, "2-mid.bin"), Buffer.alloc(8, 1));
  writeFileSync(join(src, "3-late.bin"), Buffer.alloc(8, 1));
  expect(keepScratch(src, dest, { file: 10, total: 15 })).toEqual({ files: 2, truncated: true });
  expect(statSync(join(dest, "1-big.bin")).size).toBe(10);
  expect(statSync(join(dest, "2-mid.bin")).size).toBe(5);
  expect(existsSync(join(dest, "3-late.bin"))).toBe(false);
});
