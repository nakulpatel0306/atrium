import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCapped } from "../../src/engine/capped-read";

const dirs: string[] = [];
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), "atrium-capped-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

test("a regular file within the cap is read whole", () => {
  const d = dir();
  writeFileSync(join(d, "f"), "hello\n");
  const r = readCapped(join(d, "f"), 6);
  expect(r.ok && r.bytes.toString()).toBe("hello\n");
});

test("a link is never followed, and a missing file, a folder, a FIFO and an oversized file each say why", () => {
  const d = dir();
  writeFileSync(join(d, "secret"), "token\n");
  symlinkSync(join(d, "secret"), join(d, "link"));
  mkdirSync(join(d, "folder"));
  Bun.spawnSync(["mkfifo", join(d, "fifo")]);
  writeFileSync(join(d, "big"), "x".repeat(11));
  expect(readCapped(join(d, "link"), 100)).toEqual({ ok: false, why: "not-file" });
  expect(readCapped(join(d, "nope"), 100)).toEqual({ ok: false, why: "missing" });
  expect(readCapped(join(d, "folder"), 100)).toEqual({ ok: false, why: "not-file" });
  // Opened without blocking, so a FIFO with no writer can't stall the engine.
  expect(readCapped(join(d, "fifo"), 100)).toEqual({ ok: false, why: "not-file" });
  expect(readCapped(join(d, "big"), 10)).toEqual({ ok: false, why: "too-large" });
});
