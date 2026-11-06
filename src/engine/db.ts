import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { config } from "./config";
import { migrateWatchlists } from "./markets/lists";
import { MARKETS_SCHEMA } from "./markets/schema";
import { ALWAYS_ASK } from "./approvals";

const schema = () => `
CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('repo','general','markets')),
  goal TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL,
  repo_path TEXT,
  private INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  github TEXT,
  folder TEXT
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
${APPROVALS_DDL("IF NOT EXISTS approvals")};
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
CREATE TABLE IF NOT EXISTS autonomy_proposals (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  fingerprint TEXT NOT NULL,
  evidence TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','yes','not_now','never')),
  created_at INTEGER NOT NULL,
  answered_at INTEGER,
  lifted_at INTEGER
);
CREATE TABLE IF NOT EXISTS autonomy_rules (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  fingerprint TEXT NOT NULL,
  proposal_id TEXT NOT NULL REFERENCES autonomy_proposals(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_reason TEXT
);
CREATE TABLE IF NOT EXISTS repo_clones (
  id TEXT PRIMARY KEY,
  space_id TEXT REFERENCES spaces(id),
  path TEXT NOT NULL,
  github TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('new_project','clone')),
  git_dev INTEGER NOT NULL,
  git_ino INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'present' CHECK (status IN ('present','removed')),
  last_used_at INTEGER NOT NULL,
  declined_at INTEGER,
  created_at INTEGER NOT NULL,
  removed_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS repo_clones_present ON repo_clones(path) WHERE status = 'present';
CREATE TABLE IF NOT EXISTS repo_actions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('create','remove')),
  status TEXT NOT NULL CHECK (status IN ('draft','running','done','failed','rejected')),
  approval_id TEXT NOT NULL UNIQUE REFERENCES approvals(id),
  draft TEXT,
  clone_id TEXT REFERENCES repo_clones(id),
  space_id TEXT REFERENCES spaces(id),
  remote_url TEXT,
  pushed_sha TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS run_files (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  root TEXT NOT NULL CHECK (root IN ('space','branch')),
  ref TEXT,
  path TEXT NOT NULL,
  change TEXT NOT NULL CHECK (change IN ('created','changed','deleted')),
  size INTEGER,
  insertions INTEGER,
  deletions INTEGER,
  created_at INTEGER NOT NULL,
  CHECK (root = 'space' OR ref IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS run_files_task ON run_files(task_id, created_at);
CREATE INDEX IF NOT EXISTS run_files_space ON run_files(space_id, created_at);
CREATE TABLE IF NOT EXISTS rule_events (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  proposal_id TEXT,
  rule_id TEXT,
  approval_id TEXT,
  event TEXT NOT NULL CHECK (event IN ('proposed','yes','not_now','never','suggest_again','created','applied','undone','revoked','renewed','skipped_cap')),
  actor TEXT NOT NULL CHECK (actor IN ('you','atrium')),
  created_at INTEGER NOT NULL
);
`;

export function openDb(path?: string): Database {
  const c = config();
  mkdirSync(c.home, { recursive: true });
  mkdirSync(c.transcriptsDir, { recursive: true });
  const db = new Database(path ?? c.dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(schema());
  migrate(db);
  return db;
}

// Columns added after a table first shipped; CREATE TABLE IF NOT EXISTS skips existing tables.
function migrate(db: Database) {
  const has = (table: string, column: string) =>
    (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
  // CHECK constraints can't be altered, so a table whose kinds predate markets spaces is rebuilt.
  rebuildIfMissing(db, "spaces", "'markets'", SPACES_DDL);
  rebuildIfMissing(db, "approvals", "'alert'", APPROVALS_DDL);
  // Repo approvals belong to no space and must always wait for Nakul, so the table gains both constraints.
  rebuildIfMissing(db, "approvals", "always_ask", APPROVALS_DDL);
  // And no rule may ever be recorded as deciding one.
  rebuildIfMissing(db, "approvals", "OR decided_by = 'you'", APPROVALS_DDL);
  // The GitHub repo ("owner/name") a repo space comes from, so a missing local copy can be cloned.
  if (!has("spaces", "github")) db.exec("ALTER TABLE spaces ADD COLUMN github TEXT");
  // The first commit a create run pushed, so a retry can tell its own commit from someone else's.
  if (!has("repo_actions", "pushed_sha")) db.exec("ALTER TABLE repo_actions ADD COLUMN pushed_sha TEXT");
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
  // The visible folder a general or markets space keeps its files in (see folders.ts).
  if (!has("spaces", "folder")) db.exec("ALTER TABLE spaces ADD COLUMN folder TEXT");
  // The approval a review or fix reports to, so a late one can't land on a newer approval.
  if (!has("tasks", "approval_id")) db.exec("ALTER TABLE tasks ADD COLUMN approval_id TEXT REFERENCES approvals(id)");
  // The task branch's commit when Nakul decided, so what he approved stays checkable.
  if (!has("approvals", "branch_head")) db.exec("ALTER TABLE approvals ADD COLUMN branch_head TEXT");
  // The engine-computed kind of result, so repeated approvals of the same kind can earn a rule. NULL is never counted.
  if (!has("approvals", "fingerprint")) db.exec("ALTER TABLE approvals ADD COLUMN fingerprint TEXT");
  // Who decided: Nakul, or one of his rules. Only his own decisions count towards a new rule.
  if (!has("approvals", "decided_by")) {
    db.exec("ALTER TABLE approvals ADD COLUMN decided_by TEXT NOT NULL DEFAULT 'you' CHECK (decided_by IN ('you','rule'))");
  }
  // The rule that approved it, so the rule's page can list and undo what it did.
  if (!has("approvals", "rule_id")) db.exec("ALTER TABLE approvals ADD COLUMN rule_id TEXT REFERENCES autonomy_rules(id)");
  // When Nakul undid an automatic approval; an undone one is neither evidence nor counted again.
  if (!has("approvals", "undone_at")) db.exec("ALTER TABLE approvals ADD COLUMN undone_at INTEGER");
  // The paper strategy a task runs for, so its orders can be checked against that strategy's limits.
  if (!has("tasks", "strategy_id")) db.exec("ALTER TABLE tasks ADD COLUMN strategy_id TEXT");
  // What an investing task produces (a digest or thesis write-up) and the instrument it's about.
  if (!has("tasks", "purpose")) db.exec("ALTER TABLE tasks ADD COLUMN purpose TEXT");
  if (!has("tasks", "subject")) db.exec("ALTER TABLE tasks ADD COLUMN subject TEXT");
  // Which kind of market alert an approval is, so Needs-you and notifications can group them.
  if (!has("approvals", "topic")) db.exec("ALTER TABLE approvals ADD COLUMN topic TEXT");
  // Markets tables are created here, before their own added columns are checked.
  db.exec(MARKETS_SCHEMA);
  migrateWatchlists(db);
  // The holding's book value in CAD from a Wealthsimple holdings export, for an honest CAD gain.
  if (!has("market_holdings", "book_value_cad")) db.exec("ALTER TABLE market_holdings ADD COLUMN book_value_cad REAL");
  // The export's account type ("TFSA"), so a renamed account keeps its tax treatment.
  if (!has("market_holdings", "account_type")) db.exec("ALTER TABLE market_holdings ADD COLUMN account_type TEXT");
  // The earnings date an alert last fired for, so one date fires once.
  if (!has("market_alerts", "fired_for")) db.exec("ALTER TABLE market_alerts ADD COLUMN fired_for TEXT");
  // Streaks are counted per space and kind, newest first.
  db.exec("CREATE INDEX IF NOT EXISTS approvals_fp ON approvals(space_id, fingerprint, resolved_at)");
  migrateProvider(db);
}

// Alpaca left the default path in Plan 10. A stored choice of it becomes Finnhub once; written directly, since
// nothing is listening while the database opens.
export function migrateProvider(db: Database): void {
  db.query("UPDATE settings SET value = 'finnhub' WHERE key = 'markets.provider' AND value = 'alpaca'").run();
}


// Full current definitions, migrated columns included, used only when rebuilding an older table.
const SPACES_DDL = (name: string) => `CREATE TABLE ${name} (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('repo','general','markets')),
  goal TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL,
  repo_path TEXT,
  private INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  review_by TEXT,
  github TEXT,
  folder TEXT
)`;

const APPROVALS_DDL = (name: string) => `CREATE TABLE ${name} (
  id TEXT PRIMARY KEY,
  space_id TEXT REFERENCES spaces(id),
  task_id TEXT REFERENCES tasks(id),
  kind TEXT NOT NULL CHECK (kind IN ('review','question','alert')),
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  note TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  branch_head TEXT,
  fingerprint TEXT,
  decided_by TEXT NOT NULL DEFAULT 'you' CHECK (decided_by IN ('you','rule')),
  rule_id TEXT REFERENCES autonomy_rules(id),
  undone_at INTEGER,
  topic TEXT,
  always_ask TEXT CHECK (always_ask IS NULL OR always_ask IN (${ALWAYS_ASK.map((k) => `'${k}'`).join(",")})),
  CHECK (space_id IS NOT NULL OR kind = 'question'),
  CHECK (always_ask IS NULL OR fingerprint IS NULL),
  CHECK (always_ask IS NULL OR decided_by = 'you')
)`;

// SQLite's documented table rebuild: foreign keys off (outside any transaction), copy into a new table,
// swap names, then check the rebuild left no new dangling references. Ones that were already there (old test
// fixtures, hand-edited DBs) aren't the rebuild's doing and don't stop the engine starting.
function rebuildIfMissing(db: Database, table: string, marker: string, ddl: (name: string) => string) {
  const row = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string } | null;
  if (!row || row.sql.includes(marker)) return;
  const before = db.query("PRAGMA foreign_key_check").all().length;
  const columns = (t: string) => (db.query(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec(ddl(`${table}_new`));
      const keep = columns(`${table}_new`);
      const shared = columns(table).filter((c) => keep.includes(c)).join(", ");
      db.exec(`INSERT INTO ${table}_new (${shared}) SELECT ${shared} FROM ${table}`);
      db.exec(`DROP TABLE ${table}`);
      db.exec(`ALTER TABLE ${table}_new RENAME TO ${table}`);
    })();
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
  const after = db.query("PRAGMA foreign_key_check").all().length;
  if (after > before) throw new Error(`Rebuilding ${table} left ${after - before} broken references.`);
}
