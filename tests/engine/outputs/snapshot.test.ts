import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffSnapshots, snapshotFolder } from "../../../src/engine/outputs/snapshot";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "atrium-snap-"));
  dirs.push(d);
  return d;
};
const put = (dir: string, rel: string, body: string | Buffer = "x") => {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), body);
};

test("records files with size and hash, skipping dotfiles, .env names and symlinks", () => {
  const d = temp();
  put(d, "a.md", "hello");
  put(d, "sub/b.txt", "bye");
  mkdirSync(join(d, ".claude", ".cc-writes"), { recursive: true });
  put(d, ".DS_Store");
  put(d, "prod.env");
  put(d, ".env.local");
  symlinkSync("/etc/hosts", join(d, "link.md"));
  const s = snapshotFolder(d);
  expect([...s.files.keys()].sort()).toEqual(["a.md", "sub/b.txt"]);
  expect(s.files.get("a.md")!.size).toBe(5);
  expect(s.files.get("a.md")!.hash).toMatch(/^[0-9a-f]+$/);
  expect(s.truncated).toBe(false);
});

test("a missing folder gives an empty snapshot", () => {
  const s = snapshotFolder(join(temp(), "nope"));
  expect(s.files.size).toBe(0);
  expect(s.truncated).toBe(false);
});

test("skipTop leaves out runs/", () => {
  const d = temp();
  put(d, "runs/run_1/x.md");
  expect([...snapshotFolder(d, { skipTop: ["runs"] }).files.keys()]).toEqual([]);
  expect([...snapshotFolder(d).files.keys()]).toEqual(["runs/run_1/x.md"]);
});

test("big files are listed without a hash", () => {
  const d = temp();
  put(d, "big.bin", "");
  truncateSync(join(d, "big.bin"), 2_097_152);
  const e = snapshotFolder(d).files.get("big.bin")!;
  expect(e.hash).toBeNull();
  expect(e.size).toBe(2_097_152);
});

test("caps files and depth", () => {
  const d = temp();
  for (let i = 0; i < 30; i++) put(d, `f${i}.md`);
  const s = snapshotFolder(d, { limits: { maxFiles: 10 } });
  expect(s.files.size).toBe(10);
  expect(s.truncated).toBe(true);
  const deep = temp();
  put(deep, "1/2/3/4/5/6/7/8/9/deep.md");
  put(deep, "top.md");
  const t = snapshotFolder(deep);
  expect([...t.files.keys()]).toEqual(["top.md"]);
  expect(t.truncated).toBe(true);
});

test("diff finds created, changed and deleted", () => {
  const d = temp();
  put(d, "a", "aaa");
  put(d, "b", "bbb");
  put(d, "c", "ccc");
  const before = snapshotFolder(d);
  put(d, "b", "BBB");
  rmSync(join(d, "c"));
  put(d, "d", "ddd");
  expect(diffSnapshots(before, snapshotFolder(d))).toEqual([
    { path: "b", change: "changed", size: 3 },
    { path: "c", change: "deleted", size: null },
    { path: "d", change: "created", size: 3 },
  ]);
  const again = snapshotFolder(d);
  const later = new Date(Date.now() + 60_000);
  utimesSync(join(d, "a"), later, later);
  expect(diffSnapshots(again, snapshotFolder(d))).toEqual([]);
});

test("a truncated after-snapshot reports no deletions", () => {
  const d = temp();
  for (let i = 0; i < 5; i++) put(d, `f${i}.md`);
  const before = snapshotFolder(d);
  const after = snapshotFolder(d, { limits: { maxFiles: 2 } });
  expect(after.truncated).toBe(true);
  expect(diffSnapshots(before, after)).toEqual([]);
});
