import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { config } from "../../src/engine/config";
import { openDb } from "../../src/engine/db";
import { getTask } from "../../src/engine/tasks";
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
    created_at: 1, updated_at: 2, review_by: "codex", github: null, folder: null, folder_dev: null, folder_ino: null,
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

test("an old single watchlist becomes one Holdings list per space", async () => {
  const { listLists, listItems } = await import("../../src/engine/markets/lists");
  const t = tempHome();
  const path = join(t.home, "atrium.db");
  const first = openDb(path);
  first.exec("DROP TABLE market_watchlist");
  first.exec("DROP TABLE market_lists");
  first.exec(`CREATE TABLE market_watchlist (
    space_id TEXT NOT NULL REFERENCES spaces(id), symbol TEXT NOT NULL, exchange TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '', added_at INTEGER NOT NULL, PRIMARY KEY (space_id, symbol, exchange))`);
  const space = (id: string, name: string) =>
    first.query("INSERT INTO spaces (id, name, kind, goal, color, private, status, created_at, updated_at) VALUES (?, ?, 'markets', '', '#fff', 1, 'active', 1, 1)").run(id, name);
  space("spc_a", "Investing");
  space("spc_b", "Ideas");
  const keys = ["AMZN", "ATZ", "DRAM", "MARS", "NOW", "QBTS", "QQQ", "RKLB", "SOFI", "SPY", "TSLA", "VFV", "XEQT"];
  keys.forEach((k, i) => first.query("INSERT INTO market_watchlist VALUES ('spc_a', ?, ?, '', ?)").run(k, ["ATZ", "VFV", "XEQT"].includes(k) ? "TSX" : "US", 100 - i));
  first.query("INSERT INTO market_watchlist VALUES ('spc_b', 'NVDA', 'US', 'Nvidia', 5)").run();
  first.query("INSERT INTO market_watchlist VALUES ('spc_b', 'AMD', 'US', '', 6)").run();
  first.close();

  const db = openDb(path);
  const a = listLists(db, "spc_a");
  expect(a.map((l) => [l.name, l.position])).toEqual([["Holdings", 0]]);
  // Old order is by added_at; the fixture added them in reverse.
  expect(listItems(db, a[0]!.id).map((i) => i.symbol)).toEqual([...keys].reverse());
  const b = listLists(db, "spc_b");
  expect(listItems(db, b[0]!.id).map((i) => [i.key, i.name])).toEqual([["NVDA", "Nvidia"], ["AMD", ""]]);
  db.close();

  const again = openDb(path);
  expect(listLists(again, "spc_a").map((l) => l.id)).toEqual(a.map((l) => l.id));
  expect(again.query("SELECT COUNT(*) AS n FROM market_watchlist").get()).toEqual({ n: 15 });
  expect(again.query("SELECT COUNT(*) AS n FROM market_lists").get()).toEqual({ n: 2 });
  again.close();
  t.cleanup();
});

test("market_writeups accepts kind ask after migrating an old table", () => {
  const t = tempHome();
  const path = join(t.home, "atrium.db");
  const first = openDb(path);
  first.exec("DROP TABLE market_writeups");
  first.exec(`CREATE TABLE market_writeups (id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id),
    kind TEXT NOT NULL CHECK (kind IN ('digest','thesis_draft','thesis_check')), key TEXT, for_date TEXT NOT NULL, body TEXT NOT NULL,
    task_id TEXT, created_at INTEGER NOT NULL, UNIQUE (space_id, kind, key, for_date))`);
  first.query("INSERT INTO spaces (id, name, kind, goal, color, private, status, created_at, updated_at) VALUES ('spc_a', 'Investing', 'markets', '', '#fff', 1, 'active', 1, 1)").run();
  first.query("INSERT INTO market_writeups VALUES ('w1', 'spc_a', 'digest', NULL, '2026-11-04', 'Old note', NULL, 1)").run();
  first.close();
  const db = openDb(path);
  expect(db.query("SELECT id, body FROM market_writeups").all()).toEqual([{ id: "w1", body: "Old note" }]);
  db.query("INSERT INTO market_writeups VALUES ('w2', 'spc_a', 'ask', 'AMZN', '2026-11-05T15:00:00.000Z', 'Answer', NULL, 2)").run();
  expect(db.query("SELECT COUNT(*) AS n FROM market_writeups").get()).toEqual({ n: 2 });
  db.close();
  t.cleanup();
});

test("approvals gain subject and keep their rows", () => {
  const t = tempHome();
  const path = join(t.home, "atrium.db");
  const first = openDb(path);
  first.query("INSERT INTO spaces (id, name, kind, goal, color, private, status, created_at, updated_at) VALUES ('spc_a', 'Investing', 'markets', '', '#fff', 1, 'active', 1, 1)").run();
  first.query("INSERT INTO approvals (id, space_id, kind, title, detail, created_at) VALUES ('apr_1', 'spc_a', 'alert', 'AMZN price above $1.00', '', 1)").run();
  first.exec("ALTER TABLE approvals DROP COLUMN subject");
  first.close();
  const db = openDb(path);
  expect(db.query("SELECT id, title, subject FROM approvals").all()).toEqual([{ id: "apr_1", title: "AMZN price above $1.00", subject: null }]);
  db.close();
  t.cleanup();
});

test("approvals rebuild adds send_message", () => {
  const t = tempHome();
  const path = join(t.home, "atrium.db");
  openDb(path).close();
  // The approvals table as plans 8–10 left it (514c0ea), before send_message joined the always-ask kinds.
  const old = new Database(path);
  old.exec("PRAGMA foreign_keys = OFF");
  old.exec(`DROP TABLE approvals;
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY, space_id TEXT REFERENCES spaces(id), task_id TEXT REFERENCES tasks(id),
    kind TEXT NOT NULL CHECK (kind IN ('review','question','alert')), title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')), note TEXT,
    created_at INTEGER NOT NULL, resolved_at INTEGER, branch_head TEXT, fingerprint TEXT,
    decided_by TEXT NOT NULL DEFAULT 'you' CHECK (decided_by IN ('you','rule')),
    rule_id TEXT REFERENCES autonomy_rules(id), undone_at INTEGER, topic TEXT, subject TEXT,
    always_ask TEXT CHECK (always_ask IS NULL OR always_ask IN ('merge_main','deploy','first_contact','delete','spend','secrets','create_repo','push','remove_clone')),
    CHECK (space_id IS NOT NULL OR kind = 'question'),
    CHECK (always_ask IS NULL OR fingerprint IS NULL),
    CHECK (always_ask IS NULL OR decided_by = 'you'));
  INSERT INTO approvals (id, kind, title, always_ask, created_at) VALUES ('apr_r', 'question', 'Create?', 'create_repo', 1);`);
  old.close();
  const db = openDb(path);
  expect(db.query("SELECT id, always_ask FROM approvals").get()).toEqual({ id: "apr_r", always_ask: "create_repo" });
  db.exec("INSERT INTO approvals (id, kind, title, always_ask, created_at) VALUES ('apr_m', 'question', 'Send?', 'send_message', 1)");
  expect(() => db.exec("UPDATE approvals SET status = 'approved', decided_by = 'rule' WHERE id = 'apr_m'")).toThrow();
  const sql = () => (db.query("SELECT sql FROM sqlite_master WHERE name = 'approvals'").get() as { sql: string }).sql;
  const before = sql();
  db.close();
  const again = openDb(path);
  expect((again.query("SELECT sql FROM sqlite_master WHERE name = 'approvals'").get() as { sql: string }).sql).toBe(before);
  expect((again.query("SELECT COUNT(*) AS n FROM approvals").get() as { n: number }).n).toBe(2);
  again.close();
  t.cleanup();
});

test("message_actions refuses sending without a handle", () => {
  const t = tempHome();
  const db = openDb();
  db.exec(`INSERT INTO spaces (id, name, kind, color, created_at, updated_at) VALUES ('spc_1', 'S', 'general', 'x', 1, 1);
    INSERT INTO approvals (id, space_id, kind, title, always_ask, created_at) VALUES ('apr_1', 'spc_1', 'question', 'Send?', 'send_message', 1);`);
  const insert = (status: string, handle: string | null) =>
    db
      .query("INSERT INTO message_actions (id, approval_id, space_id, to_name, handle, text, status, created_at, updated_at) VALUES (?, 'apr_1', 'spc_1', 'Dana', ?, 'hi', ?, 1, 1)")
      .run(`msa_${status}`, handle, status);
  expect(() => insert("sending", null)).toThrow();
  insert("draft", null);
  expect(() => db.exec("UPDATE message_actions SET status = 'sent' WHERE id = 'msa_draft'")).toThrow();
  expect(() => db.exec("UPDATE message_actions SET service = 'WhatsApp' WHERE id = 'msa_draft'")).toThrow();
  db.close();
  t.cleanup();
});

test("tasks gain outcome columns", () => {
  const t = tempHome();
  const db = openDb();
  const cols = (db.query("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name);
  expect(cols).toEqual(expect.arrayContaining(["outcome", "outcome_reason"]));
  db.exec(`INSERT INTO spaces (id, name, kind, color, created_at, updated_at) VALUES ('spc_1', 'S', 'general', 'x', 1, 1);
    INSERT INTO tasks (id, space_id, title, agent, weight, created_at, updated_at) VALUES ('tsk_1', 'spc_1', 't', 'claude', 'light', 1, 1);`);
  db.exec("UPDATE tasks SET outcome = 'couldnt' WHERE id = 'tsk_1'");
  expect(() => db.exec("UPDATE tasks SET outcome = 'bogus' WHERE id = 'tsk_1'")).toThrow();
  db.close();
  t.cleanup();
});

test("message_actions rebuild adds group texts and keeps every row", () => {
  const t = tempHome();
  const path = join(t.home, "atrium.db");
  openDb(path).close();
  // The table as Plan 11 left it (390038b), before group texts.
  const old = new Database(path);
  old.exec("PRAGMA foreign_keys = OFF");
  old.exec(`DROP TABLE message_actions;
  CREATE TABLE message_actions (
    id TEXT PRIMARY KEY, approval_id TEXT NOT NULL UNIQUE REFERENCES approvals(id), space_id TEXT NOT NULL REFERENCES spaces(id),
    task_id TEXT REFERENCES tasks(id), to_name TEXT NOT NULL, handle TEXT,
    handle_source TEXT CHECK (handle_source IS NULL OR handle_source IN ('contacts','you','agent')), candidates TEXT,
    service TEXT NOT NULL DEFAULT 'iMessage' CHECK (service IN ('iMessage','SMS')), text TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('draft','sending','sent','failed','rejected')), error TEXT, sent_at INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, CHECK (status NOT IN ('sending','sent') OR handle IS NOT NULL));
  INSERT INTO spaces (id, name, kind, color, created_at, updated_at) VALUES ('spc_1', 'S', 'general', 'x', 1, 1);
  INSERT INTO approvals (id, space_id, kind, title, always_ask, created_at) VALUES ('apr_1', 'spc_1', 'question', 'Send?', 'send_message', 1);
  INSERT INTO approvals (id, space_id, kind, title, always_ask, created_at) VALUES ('apr_2', 'spc_1', 'question', 'Send?', 'send_message', 1);
  INSERT INTO message_actions (id, approval_id, space_id, to_name, handle, text, status, created_at, updated_at) VALUES ('msa_old', 'apr_1', 'spc_1', 'Dana', '+15550100134', 'hi', 'sent', 1, 1);`);
  old.close();
  const db = openDb(path);
  expect(db.query("SELECT id, kind, handle, status, chat_id FROM message_actions").get()).toEqual({ id: "msa_old", kind: "person", handle: "+15550100134", status: "sent", chat_id: null });
  const insert = (status: string, chat: string | null, kind = "group") =>
    db
      .query("INSERT INTO message_actions (id, approval_id, space_id, to_name, text, status, kind, chat_id, created_at, updated_at) VALUES (?, 'apr_2', 'spc_1', 'Hike', 'hi', ?, ?, ?, 1, 1)")
      .run(`msa_${status}_${kind}`, status, kind, chat);
  expect(() => insert("sending", null)).toThrow();
  expect(() => insert("sending", "iMessage;+;chat1", "person")).toThrow();
  expect(() => insert("split", null, "person")).toThrow();
  insert("sending", "iMessage;+;chat1");
  const sql = (d: Database) => (d.query("SELECT sql FROM sqlite_master WHERE name = 'message_actions'").get() as { sql: string }).sql;
  const before = sql(db);
  db.close();
  const again = openDb(path);
  expect(sql(again)).toBe(before);
  expect((again.query("SELECT COUNT(*) AS n FROM message_actions").get() as { n: number }).n).toBe(2);
  again.close();
  t.cleanup();
});

test("an older database gains runs.remote_url and tasks.pr_url, and its rows read as before", () => {
  const t = tempHome();
  const path = join(t.home, "atrium.db");
  const old = new Database(path);
  old.exec(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, space_id TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'queued', blocked_reason TEXT, agent TEXT NOT NULL, weight TEXT NOT NULL,
    allow_on_battery INTEGER NOT NULL DEFAULT 0, branch TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE runs (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, agent TEXT NOT NULL, started_at INTEGER NOT NULL,
    ended_at INTEGER, exit_code INTEGER, input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0, transcript_path TEXT NOT NULL, start_ref TEXT, git_fingerprint TEXT);
  INSERT INTO tasks (id, space_id, title, status, agent, weight, branch, created_at, updated_at)
    VALUES ('tsk_old', 'spc', 'Old work', 'done', 'claude', 'heavy', 'atrium/tsk_old', 1, 1);
  INSERT INTO runs (id, task_id, agent, started_at, transcript_path, start_ref) VALUES ('run_old', 'tsk_old', 'claude', 1, '/tmp/x', 'main')`);
  old.close();
  const db = openDb(path);
  expect(db.query("SELECT remote_url FROM runs WHERE id = 'run_old'").get()).toEqual({ remote_url: null });
  expect(getTask(db, "tsk_old")).toMatchObject({ title: "Old work", status: "done", branch: "atrium/tsk_old", prUrl: null });
  db.close();
  openDb(path).close();
  t.cleanup();
});

test("an older database without attachments gains the table, and its tasks read as before", () => {
  const t = tempHome();
  const path = join(t.home, "atrium.db");
  const first = openDb(path);
  first.exec("INSERT INTO spaces (id, name, kind, color, created_at, updated_at) VALUES ('spc_old', 'Old', 'general', '#fff', 1, 1)");
  first.exec("INSERT INTO tasks (id, space_id, title, agent, weight, created_at, updated_at) VALUES ('tsk_old', 'spc_old', 'Kept', 'auto', 'light', 1, 1)");
  first.exec("DROP TABLE attachments");
  first.close();
  const db = openDb(path);
  expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'attachments'").get()).toEqual({ name: "attachments" });
  expect(getTask(db, "tsk_old")?.title).toBe("Kept");
  db.close();
  t.cleanup();
});

test("mail messages from before the sent flag and invitation UID gain both and keep their rows", () => {
  const t = tempHome();
  const path = join(t.home, "atrium.db");
  openDb(path).close();
  const old = new Database(path);
  old.exec("ALTER TABLE mail_messages DROP COLUMN sent");
  old.exec("ALTER TABLE mail_messages DROP COLUMN ical_uid");
  old.exec("INSERT INTO mail_accounts (id, address, source, preferred, color, created_at) VALUES ('mac_1', 'sam@example.com', 'google', 1, '#5e9fe0', 1)");
  old.exec("INSERT INTO mail_threads (id, account_id, thread_key, last_at) VALUES ('mth_1', 'mac_1', 't', 1)");
  old.exec("INSERT INTO mail_messages (id, thread_id, account_id, msg_key, source_id, date) VALUES ('msg_1', 'mth_1', 'mac_1', 'k', 's', 1)");
  old.close();
  const db = openDb(path);
  expect(db.query("SELECT id, sent, ical_uid FROM mail_messages").all()).toEqual([{ id: "msg_1", sent: 0, ical_uid: null }]);
  db.close();
  t.cleanup();
});

test("a database from Phase A mail gains the drafts table and keeps its mail", () => {
  const t = tempHome();
  const path = join(t.home, "atrium.db");
  openDb(path).close();
  const old = new Database(path);
  old.exec("DROP TABLE mail_actions");
  old.exec("INSERT INTO mail_accounts (id, address, source, preferred, color, created_at) VALUES ('mac_1', 'sam@example.com', 'google', 1, '#5e9fe0', 1)");
  old.close();
  const db = openDb(path);
  expect(db.query("SELECT address FROM mail_accounts").all()).toEqual([{ address: "sam@example.com" }]);
  expect(db.query("SELECT COUNT(*) AS n FROM mail_actions").get()).toEqual({ n: 0 });
  db.close();
  t.cleanup();
});

test("a database from before mail gains the inbox kind and mail tables, keeping every space column", () => {
  const t = tempHome();
  const path = join(t.home, "atrium.db");
  openDb(path).close();
  // Shape the spaces table the way installs before mail have it: no 'inbox' in its CHECK.
  const old = new Database(path);
  const sql = (old.query("SELECT sql FROM sqlite_master WHERE name = 'spaces'").get() as { sql: string }).sql;
  old.exec("PRAGMA foreign_keys = OFF");
  old.exec("ALTER TABLE spaces RENAME TO spaces_cur");
  old.exec(sql.replace("'markets','inbox'", "'markets'"));
  old.exec("INSERT INTO spaces SELECT * FROM spaces_cur");
  old.exec("DROP TABLE spaces_cur");
  for (const table of ["cal_events", "cal_calendars", "mail_bodies", "mail_messages", "mail_threads", "mail_accounts"]) old.exec(`DROP TABLE ${table}`);
  old.exec("INSERT INTO spaces (id, name, kind, goal, color, private, status, created_at, updated_at, folder, folder_dev, folder_ino) VALUES ('spc_g', 'Notes', 'general', 'g', 'blue', 0, 'active', 1, 2, '/f', 7, 42)");
  expect(() => old.exec("INSERT INTO spaces (id, name, kind, color, created_at, updated_at) VALUES ('spc_i', 'Inbox', 'inbox', 'x', 1, 1)")).toThrow();
  old.close();
  const db = openDb(path);
  expect(db.query("SELECT folder, folder_dev, folder_ino FROM spaces WHERE id = 'spc_g'").get()).toEqual({ folder: "/f", folder_dev: 7, folder_ino: 42 });
  db.exec("INSERT INTO spaces (id, name, kind, color, created_at, updated_at) VALUES ('spc_i', 'Inbox', 'inbox', 'x', 1, 1)");
  const names = (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
  for (const n of ["mail_accounts", "mail_threads", "mail_messages", "mail_bodies", "cal_calendars", "cal_events"]) expect(names).toContain(n);
  db.close();
  openDb(path).close();
  t.cleanup();
});
