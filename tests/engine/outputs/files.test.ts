import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchPreview, FileRefused, kindOf, PREVIEW_CAP, readPreview, readRaw, resolveInside } from "../../../src/engine/outputs/files";
import { tempRepo } from "../../helpers";

let base: string;
let root: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "atrium-files-")));
  root = join(base, "space");
  mkdirSync(join(root, "sub"), { recursive: true });
  mkdirSync(join(base, "other-space"));
  writeFileSync(join(base, "other-space", "x.md"), "other");
  writeFileSync(join(root, "a.md"), "# A\n");
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const refused = (fn: () => unknown): number => {
  try {
    fn();
  } catch (e) {
    if (e instanceof FileRefused) return e.status;
    throw e;
  }
  return 0;
};

test("resolveInside keeps every path inside the space folder", () => {
  expect(resolveInside(root, "a.md")).toBe(join(root, "a.md"));
  expect(resolveInside(root, ".")).toBe(root);
  for (const bad of ["/etc/hosts", "../x", "a/../../x", ".claude/x", "sub/.hidden", "prod.env", "a\u0000b", ""]) expect(refused(() => resolveInside(root, bad))).toBe(400);
  expect(refused(() => resolveInside(root, "missing.md"))).toBe(404);
  symlinkSync("/etc/hosts", join(root, "link.md"));
  symlinkSync("../other-space/x.md", join(root, "other.md"));
  symlinkSync("/tmp", join(root, "dir"));
  expect(refused(() => resolveInside(root, "link.md"))).toBe(403);
  expect(refused(() => resolveInside(root, "other.md"))).toBe(403);
  expect(refused(() => resolveInside(root, "dir/file"))).toBeGreaterThanOrEqual(403);
  expect(refused(() => resolveInside(root, "sub"))).toBe(400);
  try {
    resolveInside(root, "link.md");
  } catch (e) {
    expect((e as Error).message).toBe("This file points outside the space folder, so Atrium won't open it.");
  }
});

test("kindOf sorts files by what can be shown", () => {
  expect(kindOf("x.md")).toBe("markdown");
  expect(kindOf("x.ics")).toBe("calendar");
  expect(kindOf("x.png")).toBe("image");
  expect(kindOf("x.svg")).toBe("other");
  expect(kindOf("x.bin", new Uint8Array([1, 0, 2]))).toBe("other");
  expect(kindOf("notes", new TextEncoder().encode("plain words"))).toBe("text");
  expect(kindOf("x.txt", new Uint8Array([0xff, 0xfe, 0x41]))).toBe("text");
});

test("readPreview cuts big text on a whole character", () => {
  const big = "a".repeat(PREVIEW_CAP - 1) + "é" + "b".repeat(2_000_000);
  writeFileSync(join(root, "big.txt"), big);
  const p = readPreview(root, "big.txt");
  expect(p.truncated).toBe(true);
  expect(Buffer.byteLength(p.text!)).toBeLessThanOrEqual(PREVIEW_CAP);
  expect(p.text!.endsWith("a")).toBe(true);
  expect(p.text!.includes("�")).toBe(false);
});

test("readPreview answers fast for a huge file and notes binary ones", () => {
  writeFileSync(join(root, "clip.mov"), "");
  truncateSync(join(root, "clip.mov"), 50 * 1024 * 1024);
  const t = performance.now();
  const p = readPreview(root, "clip.mov");
  expect(performance.now() - t).toBeLessThan(200);
  expect(p.note).toBe("Too big to preview (50.0 MB). Open it instead.");
  expect(p.text).toBeNull();
  writeFileSync(join(root, "nul.md"), Buffer.alloc(64));
  expect(readPreview(root, "nul.md").note).toBe("This file isn't text, so there's no preview. Open it instead.");
  writeFileSync(join(root, "bad.txt"), Buffer.from([0x41, 0xff, 0x42]));
  const bad = readPreview(root, "bad.txt");
  expect(bad.kind).toBe("text");
  expect(bad.note).not.toBeNull();
});

test("readRaw serves images only", () => {
  writeFileSync(join(root, "c.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  expect(readRaw(root, "c.png")).toEqual({ bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), type: "image/png" });
  writeFileSync(join(root, "x.svg"), "<svg/>");
  expect(refused(() => readRaw(root, "x.svg"))).toBe(400);
  writeFileSync(join(root, "huge.png"), "");
  truncateSync(join(root, "huge.png"), 11 * 1024 * 1024);
  expect(refused(() => readRaw(root, "huge.png"))).toBe(413);
});

test("branchPreview reads from the task branch while main is checked out", async () => {
  const r = tempRepo();
  try {
    const git = (...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: r.path });
    git("checkout", "-b", "atrium/t1");
    mkdirSync(join(r.path, "docs"));
    writeFileSync(join(r.path, "docs", "a.md"), "# On the branch\n");
    git("add", "-A");
    git("commit", "-m", "x");
    git("checkout", "main");
    const p = await branchPreview(r.path, "atrium/t1", "docs/a.md");
    expect(p.text).toBe("# On the branch\n");
    expect(p.kind).toBe("markdown");
    expect(p.absPath).toBe(join(r.path, "docs", "a.md"));
    await expect(branchPreview(r.path, "atrium/t1", ".env")).rejects.toBeInstanceOf(FileRefused);
  } finally {
    r.cleanup();
  }
});
