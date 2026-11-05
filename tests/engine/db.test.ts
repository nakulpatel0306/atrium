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

test("openDb adds runs.start_ref and runs.git_fingerprint to an existing database", () => {
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
  expect(cols).toContain("git_fingerprint");
  db.close();
  openDb(path).close();
  t.cleanup();
});

test("migration adds task kind, parent, ignore_reserve and space review_by", () => {
  const t = tempHome();
  const path = join(t.home, "atrium.db");
  const old = new Database(path);
  old.exec(`CREATE TABLE spaces (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, goal TEXT NOT NULL DEFAULT '', color TEXT NOT NULL,
    repo_path TEXT, private INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, space_id TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'queued', blocked_reason TEXT, agent TEXT NOT NULL, weight TEXT NOT NULL,
    allow_on_battery INTEGER NOT NULL DEFAULT 0, branch TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  INSERT INTO tasks (id, space_id, title, agent, weight, created_at, updated_at) VALUES ('tsk_old', 'spc', 'old', 'claude', 'heavy', 1, 1)`);
  old.close();
  const db = openDb(path);
  const cols = (table: string) => (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  expect(cols("tasks")).toEqual(expect.arrayContaining(["kind", "parent_task_id", "ignore_reserve"]));
  expect(cols("spaces")).toContain("review_by");
  expect(db.query("SELECT kind, ignore_reserve, parent_task_id FROM tasks").get()).toEqual({
    kind: "work",
    ignore_reserve: 0,
    parent_task_id: null,
  });
  db.close();
  openDb(path).close();
  t.cleanup();
});
