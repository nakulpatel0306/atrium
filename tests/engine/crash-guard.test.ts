import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isFatalDbError, noteRestart, RESTARTED } from "../../src/engine/crash-guard";
import { openDb } from "../../src/engine/db";
import { listActivity } from "../../src/engine/events";
import { tempHome } from "../helpers";

let home: ReturnType<typeof tempHome>;
let db: Database;
beforeEach(() => {
  home = tempHome();
  db = openDb();
});
afterEach(() => {
  db.close();
  home.cleanup();
});

const guard = join(import.meta.dir, "../../src/engine/crash-guard.ts");

// Each case runs in a process of its own, with the guard installed the way main.ts installs it.
async function run(body: string, marker: string) {
  const script = `
    const { installCrashGuard } = await import(${JSON.stringify(guard)});
    installCrashGuard({ marker: ${JSON.stringify(marker)} });
    ${body}
    setTimeout(() => console.log("still running"), 80);
  `;
  const proc = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out, err, code };
}

test("a stray rejection is logged with secrets hidden, and the engine keeps running", async () => {
  const marker = join(home.home, "crashed");
  const r = await run(`Promise.reject(new Error("clone landed late token=abc123"));`, marker);
  expect(r.code).toBe(0);
  expect(r.out).toContain("still running");
  expect(r.err).toContain("Atrium caught a failure nothing else handled and kept running: Error: clone landed late token=[redacted]");
  expect(r.err).not.toContain("abc123");
  expect(existsSync(marker)).toBe(false);
});

test("a synchronous throw exits 1 so launchd restarts it, and leaves the marker", async () => {
  const marker = join(home.home, "crashed");
  const r = await run(`setTimeout(() => { throw new Error("runner state half updated"); }, 10);`, marker);
  expect(r.code).toBe(1);
  expect(r.out).not.toContain("still running");
  expect(r.err).toContain("Atrium stopped after an error nothing else handled; launchd starts it again: Error: runner state half updated");
  expect(existsSync(marker)).toBe(true);
});

test("a rejection from a damaged or full database exits 1 too", async () => {
  const marker = join(home.home, "crashed");
  const r = await run(`const e = new Error("database or disk is full"); e.code = "SQLITE_FULL"; Promise.reject(e);`, marker);
  expect(r.code).toBe(1);
  expect(r.err).toContain("Atrium stopped after a database error");
  expect(isFatalDbError(Object.assign(new Error("x"), { code: "SQLITE_IOERR_WRITE" }))).toBe(true);
  expect(isFatalDbError(new Error("database disk image is malformed"))).toBe(true);
  expect(isFatalDbError(new Error("FOREIGN KEY constraint failed"))).toBe(false);
});

test("the next boot after a crash says so once in Activity", () => {
  const marker = join(home.home, "crashed");
  writeFileSync(marker, "1");
  expect(noteRestart(db, marker)).toBe(true);
  expect(noteRestart(db, marker)).toBe(false);
  expect(listActivity(db).map((r) => r.message)).toEqual([RESTARTED]);
  expect(existsSync(marker)).toBe(false);
});
