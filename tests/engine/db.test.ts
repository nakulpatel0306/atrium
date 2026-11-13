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

// An install last opened between always-ask (f8e9e34) and 8c98d90 has an approvals table without the decided_by
// check, and may hold kinds of removed features. The rebuild keeps those rows instead of refusing to boot.
test("an older approvals table holding removed kinds is rebuilt with its rows kept", () => {
  const t = tempHome();
  const path = join(t.home, "atrium.db");
  openDb(path).close();
  const old = new Database(path);
  old.exec("PRAGMA foreign_keys = OFF");
  old.exec(`DROP TABLE approvals;
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY, space_id TEXT REFERENCES spaces(id), task_id TEXT REFERENCES tasks(id),
    kind TEXT NOT NULL CHECK (kind IN ('review','question','alert')), title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')), note TEXT,
    created_at INTEGER NOT NULL, resolved_at INTEGER, branch_head TEXT, fingerprint TEXT,
    decided_by TEXT NOT NULL DEFAULT 'you' CHECK (decided_by IN ('you','rule')),
    rule_id TEXT REFERENCES autonomy_rules(id), undone_at INTEGER,
    always_ask TEXT CHECK (always_ask IS NULL OR always_ask IN ('merge_main','deploy','first_contact','delete','spend','secrets','create_repo','push','remove_clone','send_message')),
    CHECK (space_id IS NOT NULL OR kind = 'question'),
    CHECK (always_ask IS NULL OR fingerprint IS NULL));
  INSERT INTO spaces (id, name, kind, color, created_at, updated_at) VALUES ('spc_1', 'S', 'general', 'x', 1, 1);
  INSERT INTO approvals (id, space_id, kind, title, created_at) VALUES ('apr_alert', 'spc_1', 'alert', 'Price alert', 1);
  INSERT INTO approvals (id, space_id, kind, title, always_ask, created_at) VALUES ('apr_first', 'spc_1', 'question', 'First text to Dana', 'first_contact', 2);
  INSERT INTO approvals (id, space_id, kind, title, always_ask, created_at) VALUES ('apr_send', 'spc_1', 'question', 'Send the text', 'send_message', 3);`);
  old.close();
  const db = openDb(path);
  expect(db.query("SELECT id, kind, always_ask FROM approvals ORDER BY created_at").all()).toEqual([
    { id: "apr_alert", kind: "alert", always_ask: null },
    { id: "apr_first", kind: "question", always_ask: "first_contact" },
    { id: "apr_send", kind: "question", always_ask: "send_message" },
  ]);
  expect(() => db.exec("UPDATE approvals SET status = 'approved', decided_by = 'rule' WHERE id = 'apr_send'")).toThrow();
  db.close();
  openDb(path).close();
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
  expect(() => db.exec("INSERT INTO spaces (id, name, kind, color, created_at, updated_at) VALUES ('spc_1', 'S', 'general', 'x', 1, 1); INSERT INTO approvals (id, space_id, kind, title, created_at) VALUES ('apr_a', 'spc_1', 'alert', 'a', 1)")).toThrow();
  expect(() => db.exec("INSERT INTO approvals (id, kind, title, always_ask, created_at) VALUES ('apr_s', 'question', 'q', 'send_message', 1)")).toThrow();
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
