import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { config } from "./config";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('repo','general')),
  goal TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL,
  repo_path TEXT,
  private INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','review','done','failed','blocked')),
  blocked_reason TEXT,
  agent TEXT NOT NULL,
  weight TEXT NOT NULL CHECK (weight IN ('heavy','light')),
  allow_on_battery INTEGER NOT NULL DEFAULT 0,
  branch TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  agent TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  exit_code INTEGER,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  transcript_path TEXT NOT NULL,
  start_ref TEXT,
  git_fingerprint TEXT
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  task_id TEXT REFERENCES tasks(id),
  kind TEXT NOT NULL CHECK (kind IN ('review','question')),
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  note TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,
  space_id TEXT REFERENCES spaces(id),
  actor TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function openDb(path?: string): Database {
  const c = config();
  mkdirSync(c.home, { recursive: true });
  mkdirSync(c.transcriptsDir, { recursive: true });
  const db = new Database(path ?? c.dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Columns added after a table first shipped; CREATE TABLE IF NOT EXISTS skips existing tables.
function migrate(db: Database) {
  const has = (table: string, column: string) =>
    (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
  // The branch a run started from, so a crashed run's repo can be put back on boot.
  if (!has("runs", "start_ref")) db.exec("ALTER TABLE runs ADD COLUMN start_ref TEXT");
  // The repo's git settings before the run, so recovery and resume can tell if the agent changed them.
  if (!has("runs", "git_fingerprint")) db.exec("ALTER TABLE runs ADD COLUMN git_fingerprint TEXT");
  // Lets one task run during the Claude window reserve ("Run now").
  if (!has("tasks", "ignore_reserve")) db.exec("ALTER TABLE tasks ADD COLUMN ignore_reserve INTEGER NOT NULL DEFAULT 0");
  if (!has("tasks", "kind")) {
    db.exec("ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'work' CHECK (kind IN ('work','review','fix'))");
  }
  // A review or fix task points at the work task it follows.
  if (!has("tasks", "parent_task_id")) db.exec("ALTER TABLE tasks ADD COLUMN parent_task_id TEXT REFERENCES tasks(id)");
  // Which agent reviews this space's finished work; NULL means no automatic review.
  if (!has("spaces", "review_by")) db.exec("ALTER TABLE spaces ADD COLUMN review_by TEXT");
}

