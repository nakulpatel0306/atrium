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
  for (const n of ["spaces", "tasks", "runs", "approvals", "activity", "settings", "autonomy_proposals", "autonomy_rules", "rule_events"]) expect(names).toContain(n);
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

test("an existing database gains the autonomy columns", () => {
  const t = tempHome();
  const path = join(t.home, "atrium.db");
  const old = new Database(path);
  old.exec(`CREATE TABLE spaces (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('repo','general')), goal TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL, repo_path TEXT, private INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id), task_id TEXT REFERENCES tasks(id),
    kind TEXT NOT NULL CHECK (kind IN ('review','question')), title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')), note TEXT,
    created_at INTEGER NOT NULL, resolved_at INTEGER, branch_head TEXT);
  INSERT INTO spaces (id, name, kind, color, created_at, updated_at) VALUES ('spc_old', 'Old', 'general', 'blue', 1, 1);
  INSERT INTO approvals (id, space_id, kind, title, status, created_at, resolved_at) VALUES ('apr_old', 'spc_old', 'review', 'old', 'approved', 1, 2)`);
  old.close();
  const db = openDb(path);
  const cols = (db.query("PRAGMA table_info(approvals)").all() as { name: string }[]).map((c) => c.name);
  expect(cols).toEqual(expect.arrayContaining(["fingerprint", "decided_by", "rule_id", "undone_at"]));
  expect(db.query("SELECT decided_by, fingerprint, rule_id, undone_at FROM approvals").get()).toEqual({
    decided_by: "you",
    fingerprint: null,
    rule_id: null,
    undone_at: null,
  });
  db.close();
  openDb(path).close();
  t.cleanup();
});

test("old DB gains markets and alert kinds", () => {
  const t = tempHome();
  const path = join(t.home, "atrium.db");
  const old = new Database(path);
  old.exec(`CREATE TABLE spaces (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('repo','general')), goal TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL, repo_path TEXT, private INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, review_by TEXT);
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id), title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'queued', blocked_reason TEXT, agent TEXT NOT NULL, weight TEXT NOT NULL,
    allow_on_battery INTEGER NOT NULL DEFAULT 0, branch TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id), task_id TEXT REFERENCES tasks(id),
    kind TEXT NOT NULL CHECK (kind IN ('review','question')), title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')), note TEXT,
    created_at INTEGER NOT NULL, resolved_at INTEGER, branch_head TEXT);
  INSERT INTO spaces (id, name, kind, goal, color, repo_path, private, status, created_at, updated_at, review_by)
    VALUES ('spc_old', 'Old', 'repo', 'g', 'blue', '/r', 1, 'active', 1, 2, 'codex');
  INSERT INTO tasks (id, space_id, title, agent, weight, created_at, updated_at) VALUES ('tsk_old', 'spc_old', 'old', 'claude', 'heavy', 1, 1);
  INSERT INTO approvals (id, space_id, task_id, kind, title, detail, status, note, created_at, resolved_at, branch_head)
    VALUES ('apr_old', 'spc_old', 'tsk_old', 'review', 'old', 'd', 'approved', 'n', 1, 2, 'abc')`);
  old.close();
  const db = openDb(path);
  expect(db.query("SELECT * FROM spaces").get()).toEqual({
    id: "spc_old", name: "Old", kind: "repo", goal: "g", color: "blue", repo_path: "/r", private: 1, status: "active",
    created_at: 1, updated_at: 2, review_by: "codex", github: null, folder: null,
  });
  expect(db.query("SELECT id, space_id, task_id, kind, title, detail, status, note, created_at, resolved_at, branch_head, decided_by FROM approvals").get()).toEqual({
    id: "apr_old", space_id: "spc_old", task_id: "tsk_old", kind: "review", title: "old", detail: "d", status: "approved",
    note: "n", created_at: 1, resolved_at: 2, branch_head: "abc", decided_by: "you",
  });
  db.exec("INSERT INTO spaces (id, name, kind, color, created_at, updated_at) VALUES ('spc_m', 'M', 'markets', 'x', 1, 1)");
  db.exec("INSERT INTO approvals (id, space_id, kind, title, created_at) VALUES ('apr_a', 'spc_m', 'alert', 'a', 1)");
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(() => db.exec("INSERT INTO tasks (id, space_id, title, agent, weight, created_at, updated_at) VALUES ('t2', 'nope', 't', 'c', 'heavy', 1, 1)")).toThrow();
  const cols = (db.query("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name);
  expect(cols).toContain("strategy_id");
  db.close();
  const again = openDb(path);
  expect((again.query("SELECT COUNT(*) AS n FROM approvals").get() as { n: number }).n).toBe(2);
  again.close();
  t.cleanup();
});

test("markets tables exist", () => {
  const t = tempHome();
  const db = openDb();
  const names = (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
  for (const n of ["market_watchlist", "market_holdings", "market_quotes", "market_bars", "market_alerts", "paper_accounts", "paper_fills", "market_strategies"]) expect(names).toContain(n);
  db.close();
  t.cleanup();
});

const PLAN7_TABLES = [
  "fx_rates", "market_closes", "market_dividends", "fund_files", "fund_lines", "instrument_meta", "market_earnings",
  "market_news", "research_notes", "market_writeups", "market_ideas", "tfsa_room", "tfsa_entries",
];
const PLAN7_COLUMNS: [string, string][] = [
  ["market_holdings", "book_value_cad"], ["market_holdings", "account_type"], ["market_alerts", "fired_for"], ["tasks", "purpose"], ["tasks", "subject"], ["approvals", "topic"],
];

test("plan 7 tables exist", () => {
  const t = tempHome();
  const db = openDb();
  const names = (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
  for (const n of PLAN7_TABLES) expect(names).toContain(n);
  db.close();
  t.cleanup();
});

test("old DB gains plan 7 columns", () => {
  const t = tempHome();
  const path = join(t.home, "atrium.db");
  const db = openDb(path);
  db.exec(`INSERT INTO spaces (id, name, kind, color, created_at, updated_at) VALUES ('spc_m', 'M', 'markets', 'x', 1, 1);
    INSERT INTO tasks (id, space_id, title, agent, weight, created_at, updated_at) VALUES ('tsk_1', 'spc_m', 't', 'claude', 'light', 1, 1);
    INSERT INTO approvals (id, space_id, kind, title, created_at) VALUES ('apr_1', 'spc_m', 'alert', 'a', 1);
    INSERT INTO market_holdings (id, space_id, account, symbol, exchange, quantity, currency, source, updated_at) VALUES ('h1', 'spc_m', 'TFSA', 'SPY', 'US', 2, 'USD', 'manual', 1);
    INSERT INTO market_alerts (id, space_id, key, rule, created_at) VALUES ('al1', 'spc_m', 'SPY', '{}', 1);`);
  // A Plan 6 database: the same tables without the plan 7 columns.
  for (const [table, column] of PLAN7_COLUMNS) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  db.close();
  const cols = (d: Database, table: string) => (d.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  const again = openDb(path);
  for (const [table, column] of PLAN7_COLUMNS) expect(cols(again, table)).toContain(column);
  for (const table of ["tasks", "approvals", "market_holdings", "market_alerts"]) {
    expect((again.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(1);
  }
  again.close();
  const third = openDb(path);
  expect(cols(third, "tasks").filter((c) => c === "purpose")).toHaveLength(1);
  third.close();
  t.cleanup();
});

test("approvals rebuild adds always_ask and allows spaceless questions", () => {
  const t = tempHome();
  const path = join(t.home, "atrium.db");
  openDb(path).close();
  // Put the approvals table back to its definition before plan 8 (b569433).
  const old = new Database(path);
  old.exec("PRAGMA foreign_keys = OFF");
  old.exec(`DROP TABLE approvals;
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id), task_id TEXT REFERENCES tasks(id),
    kind TEXT NOT NULL CHECK (kind IN ('review','question','alert')), title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')), note TEXT,
    created_at INTEGER NOT NULL, resolved_at INTEGER, branch_head TEXT, fingerprint TEXT,
    decided_by TEXT NOT NULL DEFAULT 'you' CHECK (decided_by IN ('you','rule')),
    rule_id TEXT REFERENCES autonomy_rules(id), undone_at INTEGER);
  INSERT INTO spaces (id, name, kind, color, created_at, updated_at) VALUES ('spc_1', 'S', 'general', 'x', 1, 1);
  INSERT INTO tasks (id, space_id, title, agent, weight, created_at, updated_at) VALUES ('tsk_1', 'spc_1', 't', 'claude', 'light', 1, 1);
  INSERT INTO approvals (id, space_id, task_id, kind, title, created_at) VALUES ('apr_1', 'spc_1', 'tsk_1', 'review', 'r', 1);`);
  old.close();
  const db = openDb(path);
  expect(db.query("SELECT id, space_id, task_id, always_ask FROM approvals").get()).toEqual({ id: "apr_1", space_id: "spc_1", task_id: "tsk_1", always_ask: null });
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  db.exec("INSERT INTO approvals (id, kind, title, always_ask, created_at) VALUES ('apr_q', 'question', 'q', 'create_repo', 1)");
  expect(() => db.exec("INSERT INTO approvals (id, kind, title, created_at) VALUES ('apr_r', 'review', 'r', 1)")).toThrow();
  expect(() =>
    db.exec("INSERT INTO approvals (id, kind, title, always_ask, fingerprint, created_at) VALUES ('apr_f', 'question', 'q', 'create_repo', 'v1:general:text:claude', 1)"),
  ).toThrow();
  expect(() => db.exec("INSERT INTO approvals (id, kind, title, always_ask, created_at) VALUES ('apr_x', 'question', 'q', 'nope', 1)")).toThrow();
  expect(() => db.exec("UPDATE approvals SET fingerprint = 'v1:general:text:claude' WHERE id = 'apr_q'")).toThrow();
  db.close();
  const again = openDb(path);
  expect((again.query("SELECT COUNT(*) AS n FROM approvals").get() as { n: number }).n).toBe(2);
  again.close();
  t.cleanup();
});

test("repo tables and spaces.github exist", () => {
  const t = tempHome();
  const db = openDb();
  const names = (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
  expect(names).toContain("repo_clones");
  expect(names).toContain("repo_actions");
  const cols = (db.query("PRAGMA table_info(spaces)").all() as { name: string }[]).map((c) => c.name);
  expect(cols).toContain("github");
  const row = "INSERT INTO repo_clones (id, path, github, origin, git_dev, git_ino, last_used_at, created_at) VALUES (?, '/p/a', 'o/a', 'clone', 1, 2, 1, 1)";
  db.query(row).run("cln_1");
  expect(() => db.query(row).run("cln_2")).toThrow();
  db.exec("UPDATE repo_clones SET status = 'removed' WHERE id = 'cln_1'");
  db.query(row).run("cln_3");
  db.close();
  t.cleanup();
});

test("an old spaces table gains github", () => {
  const t = tempHome();
  const path = join(t.home, "atrium.db");
  openDb(path).close();
  const old = new Database(path);
  old.exec("PRAGMA foreign_keys = OFF");
  old.exec(`DROP TABLE spaces; CREATE TABLE spaces (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('repo','general','markets')), goal TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL, repo_path TEXT, private INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, review_by TEXT)`);
  old.close();
  const db = openDb(path);
  const cols = (db.query("PRAGMA table_info(spaces)").all() as { name: string }[]).map((c) => c.name);
  expect(cols).toContain("github");
  db.close();
  t.cleanup();
});

test("an always-ask approval can only ever be decided by you", () => {
  const t = tempHome();
  const db = openDb();
  db.exec("INSERT INTO approvals (id, kind, title, always_ask, created_at) VALUES ('apr_q', 'question', 'q', 'create_repo', 1)");
  expect(() => db.exec("UPDATE approvals SET status = 'approved', decided_by = 'rule' WHERE id = 'apr_q'")).toThrow();
  db.exec("UPDATE approvals SET status = 'approved' WHERE id = 'apr_q'");
  db.close();
  t.cleanup();
});

test("run_files exists and refuses a branch row without ref", () => {
  const t = tempHome();
  const path = join(t.home, "atrium.db");
  openDb(path).close();
  const db = openDb(path);
  const now = Date.now();
  db.exec("PRAGMA foreign_keys = OFF");
  db.query("INSERT INTO run_files (id, run_id, task_id, space_id, root, ref, path, change, created_at) VALUES ('f1','r','t','s','space',NULL,'a.md','created',?)").run(now);
  expect(() =>
    db.query("INSERT INTO run_files (id, run_id, task_id, space_id, root, ref, path, change, created_at) VALUES ('f2','r','t','s','branch',NULL,'a.md','created',?)").run(now),
  ).toThrow();
  const idx = (db.query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='run_files'").all() as { name: string }[]).map((r) => r.name);
  expect(idx).toEqual(expect.arrayContaining(["run_files_task", "run_files_space"]));
  db.close();
  t.cleanup();
});

test("a stored alpaca provider becomes finnhub once", () => {
  const t = tempHome();
  const path = join(t.home, "atrium.db");
  const first = openDb(path);
  first.query("INSERT INTO settings (key, value) VALUES ('markets.provider', 'alpaca')").run();
  first.close();
  const db = openDb(path);
  expect(db.query("SELECT value FROM settings WHERE key = 'markets.provider'").get()).toEqual({ value: "finnhub" });
  db.query("UPDATE settings SET value = 'demo' WHERE key = 'markets.provider'").run();
  db.close();
  const again = openDb(path);
  expect(again.query("SELECT value FROM settings WHERE key = 'markets.provider'").get()).toEqual({ value: "demo" });
  again.close();
  t.cleanup();
});
