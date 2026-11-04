import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { config } from "../../src/engine/config";
import { openDb } from "../../src/engine/db";
import { tempHome } from "../helpers";

test("openDb creates all tables", () => {
  const t = tempHome();
  const db = openDb();
  const names = (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
  for (const n of ["spaces", "tasks", "runs", "approvals", "activity", "settings"]) expect(names).toContain(n);
  db.close();
  t.cleanup();
});

test("openDb is idempotent", () => {
  const t = tempHome();
  const path = join(t.home, "atrium.db");
  openDb(path).close();
  const db = openDb(path);
  const row = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
  expect(row.journal_mode).toBe("wal");
  db.close();
  t.cleanup();
});

test("config honors ATRIUM_HOME", () => {
  const t = tempHome();
  expect(config().home).toBe(t.home);
  expect(config().dbPath.endsWith("atrium.db")).toBe(true);
  t.cleanup();
});

test("openDb adds runs.start_ref to an existing database", () => {
  const t = tempHome();
  const path = join(t.home, "atrium.db");
  const old = new Database(path);
  old.exec(`CREATE TABLE runs (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, agent TEXT NOT NULL, started_at INTEGER NOT NULL,
    ended_at INTEGER, exit_code INTEGER, input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0, transcript_path TEXT NOT NULL)`);
  old.close();
  const db = openDb(path);
  const cols = (db.query("PRAGMA table_info(runs)").all() as { name: string }[]).map((c) => c.name);
  expect(cols).toContain("start_ref");
  db.close();
  openDb(path).close();
  t.cleanup();
});
