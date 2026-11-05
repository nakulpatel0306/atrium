import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SANDBOX_EXEC, seatbeltProfile } from "../../src/engine/agents/seatbelt";
import { keepScratch } from "../../src/engine/scratch";
import { tempHome } from "../helpers";

let home: ReturnType<typeof tempHome>;
const dirs: string[] = [];
beforeEach(() => {
  home = tempHome();
});
afterEach(() => {
  home.cleanup();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "atrium-scratch-test-"));
  dirs.push(d);
  return d;
};
// Where the runner keeps a run's files: inside Atrium's own folder, which the copy's sandbox otherwise can't read.
const runDir = () => join(home.home, "spaces", "spc_1", "runs", `run_${Math.random().toString(36).slice(2)}`);

// Atrium's own folder is unreadable inside the sandbox, so a canary there stands in for a secret.
function canary() {
  const file = join(home.home, "secret.txt");
  writeFileSync(file, "canary");
  return file;
}

test("copies files and folders and keeps no symlinks", async () => {
  const src = temp();
  const dest = runDir();
  writeFileSync(join(src, "a.txt"), "a");
  mkdirSync(join(src, "d"));
  writeFileSync(join(src, "d", "b.txt"), "b");
  symlinkSync(join(src, "a.txt"), join(src, "link"));
  expect(await keepScratch(src, dest)).toEqual({ files: 2, truncated: false, skipped: 1 });
  expect(readFileSync(join(dest, "d", "b.txt"), "utf8")).toBe("b");
  expect(existsSync(join(dest, "link"))).toBe(false);
});

test("an empty folder keeps nothing and leaves no folder behind", async () => {
  const dest = runDir();
  expect(await keepScratch(temp(), dest)).toEqual({ files: 0, truncated: false, skipped: 0 });
  expect(existsSync(dest)).toBe(false);
});

test("cuts files at the per-file cap and stops at the per-run cap", async () => {
  const src = temp();
  const dest = runDir();
  writeFileSync(join(src, "1-big.bin"), Buffer.alloc(30, 1));
  writeFileSync(join(src, "2-mid.bin"), Buffer.alloc(8, 1));
  writeFileSync(join(src, "3-late.bin"), Buffer.alloc(8, 1));
  expect(await keepScratch(src, dest, { caps: { file: 10, total: 15 } })).toEqual({ files: 2, truncated: true, skipped: 0 });
  expect(statSync(join(dest, "1-big.bin")).size).toBe(10);
  expect(statSync(join(dest, "2-mid.bin")).size).toBe(5);
  expect(existsSync(join(dest, "3-late.bin"))).toBe(false);
});

test("a symlink to a secret in a denied folder is neither copied nor readable", async () => {
  const src = temp();
  const dest = runDir();
  symlinkSync(canary(), join(src, "looks-normal.txt"));
  const dir = join(src, "dir");
  symlinkSync(home.home, dir);
  expect(await keepScratch(src, dest)).toEqual({ files: 0, truncated: false, skipped: 2 });
  expect(existsSync(join(dest, "looks-normal.txt"))).toBe(false);
  expect(existsSync(join(dest, "dir"))).toBe(false);
});

// The copy reads with the agent's own rights, so what matters is that the agent can't plant such a link.
test("an agent can't plant a hard link to a secret for the copy to pick up", async () => {
  const src = temp();
  const dest = runDir();
  const secret = canary();
  const ln = Bun.spawnSync([SANDBOX_EXEC, "-p", seatbeltProfile({ cwd: src, writable: [src] }), "/bin/ln", secret, join(src, "hard.txt")]);
  expect(ln.exitCode).not.toBe(0);
  writeFileSync(join(src, "ok.txt"), "ok");
  expect(await keepScratch(src, dest)).toEqual({ files: 1, truncated: false, skipped: 0 });
  expect(existsSync(join(dest, "hard.txt"))).toBe(false);
});

test(".env files stay behind", async () => {
  const src = temp();
  const dest = runDir();
  writeFileSync(join(src, ".env"), "X=1");
  writeFileSync(join(src, "ok.txt"), "ok");
  expect(await keepScratch(src, dest)).toEqual({ files: 1, truncated: false, skipped: 1 });
  expect(existsSync(join(dest, ".env"))).toBe(false);
});

test("the copy fails closed when its sandbox can't start", async () => {
  const src = temp();
  const dest = runDir();
  writeFileSync(join(src, "a.txt"), "a");
  await expect(keepScratch(src, dest, { sandboxExec: join(temp(), "missing-sandbox-exec") })).rejects.toThrow(
    "the sandbox for copying them didn't start",
  );
  expect(existsSync(dest)).toBe(false);
});
