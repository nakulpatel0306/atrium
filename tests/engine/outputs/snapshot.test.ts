import { afterEach, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffSnapshots, readRegular, SNAPSHOT_LIMITS, snapshotFolder } from "../../../src/engine/outputs/snapshot";

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

test("a file swapped for a link after lstat is never read through the link", () => {
  const d = temp();
  const secret = join(temp(), "secret.txt");
  writeFileSync(secret, "secret");
  put(d, "notes.md", "public");
  const seen = lstatSync(join(d, "notes.md"));
  rmSync(join(d, "notes.md"));
  symlinkSync(secret, join(d, "notes.md"));
  expect(readRegular(join(d, "notes.md"), seen, 1024)).toBeNull();
  // A different regular file at the same path (another inode) is refused too.
  rmSync(join(d, "notes.md"));
  writeFileSync(join(d, "notes.md"), "swapped");
  expect(readRegular(join(d, "notes.md"), seen, 1024)).toBeNull();
  expect(new TextDecoder().decode(readRegular(join(d, "notes.md"), lstatSync(join(d, "notes.md")), 1024)!)).toBe("swapped");
});

test("hashing stops at a total budget; later files fall back to size and mtime", () => {
  const d = temp();
  for (let i = 0; i < 12; i++) put(d, `f${String(i).padStart(2, "0")}.bin`, Buffer.alloc(1_000_000, i));
  const s = snapshotFolder(d, { limits: { hashTotalBytes: 5_000_000 } });
  const hashed = [...s.files.values()].filter((e) => e.hash !== null).length;
  expect(hashed).toBe(5);
  expect(s.files.size).toBe(12);
  expect(SNAPSHOT_LIMITS.hashTotalBytes).toBe(64 * 1024 * 1024);
  // An unhashed file with new bytes, the same size and a new mtime still counts as changed.
  const before = s;
  put(d, "f11.bin", Buffer.alloc(1_000_000, 99));
  const later = new Date(Date.now() + 60_000);
  utimesSync(join(d, "f11.bin"), later, later);
  expect(diffSnapshots(before, snapshotFolder(d, { limits: { hashTotalBytes: 5_000_000 } }))).toEqual([{ path: "f11.bin", change: "changed", size: 1_000_000 }]);
});

test("a truncated before-snapshot doesn't call files past where it stopped new", () => {
  const d = temp();
  for (const n of ["a.md", "b.md", "c.md", "d.md"]) put(d, n);
  put(d, "sub/z.md");
  const before = snapshotFolder(d, { limits: { maxFiles: 2 } });
  expect(before.truncated).toBe(true);
  put(d, "a2.md");
  const changes = diffSnapshots(before, snapshotFolder(d));
  // a2.md sorts within what the first walk saw (a.md, a2.md, b.md); c.md, d.md and sub/z.md were never seen.
  expect(changes).toEqual([{ path: "a2.md", change: "created", size: 1 }]);
});
