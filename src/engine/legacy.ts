import type { Database } from "bun:sqlite";

// Tables of features Atrium no longer has. A fresh install never creates them, but an older database still holds
// them, and their rows point at spaces, tasks and approvals. Nothing reads them any more; the only thing that
// touches them is a delete the user asks for, which has to clear them or the foreign keys would refuse it.
export const LEGACY = {
  // Rows keyed by space, children before parents.
  bySpace: [
    "mail_actions", "message_actions", "market_watchlist", "market_lists", "market_holdings", "market_alerts", "paper_fills", "paper_accounts",
    "market_strategies", "research_notes", "market_writeups", "market_ideas", "money_transactions", "money_imports", "money_budgets",
    "money_nudges", "money_accounts",
  ],
  // Rows that mention a task and keep their own row when it goes.
  byTask: ["mail_actions", "message_actions", "paper_fills", "market_writeups"],
  // Rows that belong to one approval and go with it.
  byApproval: ["mail_actions", "message_actions"],
  // Approval kinds and always-ask values only those features made. An older approvals table can still hold them, so
  // rebuilding it keeps them allowed; nothing lists or decides them.
  approvalKinds: ["alert"],
  alwaysAsk: ["first_contact", "send_message"],
} as const;

const present = (db: Database, table: string): boolean => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);

export function legacyDelete(db: Database, tables: readonly string[], column: string, ids: string[]): void {
  if (!ids.length) return;
  const marks = ids.map(() => "?").join(",");
  for (const t of tables) if (present(db, t)) db.query(`DELETE FROM ${t} WHERE ${column} IN (${marks})`).run(...ids);
}

export function legacyUnlinkTasks(db: Database, tasks: string[]): void {
  if (!tasks.length) return;
  const marks = tasks.map(() => "?").join(",");
  for (const t of LEGACY.byTask) if (present(db, t)) db.query(`UPDATE ${t} SET task_id = NULL WHERE task_id IN (${marks})`).run(...tasks);
}

export const REMOVED_FEATURE_RETRY = "This task belongs to a feature Atrium no longer has, so it can't run again.";
export const STAYS_PRIVATE = "This space came from a feature Atrium no longer has, so it stays private.";
export const REMOVED_FEATURE_QUESTION = "This came from a feature Atrium no longer has, so it was closed.";

// Pending questions an older Atrium asked for a removed feature: paper-strategy proposals, and questions with no task
// in a space of a removed kind (only those features asked those). Answering one would do nothing, so boot closes them
// with a plain note and keeps the rows.
export function closeLegacyApprovals(db: Database): number {
  const strategies = present(db, "market_strategies") ? " OR id IN (SELECT approval_id FROM market_strategies WHERE approval_id IS NOT NULL)" : "";
  const res = db
    .query(
      `UPDATE approvals SET status = 'rejected', note = ?, resolved_at = ? WHERE status = 'pending' AND (
        (task_id IS NULL AND space_id IN (SELECT id FROM spaces WHERE kind NOT IN ('repo','general')))${strategies})`,
    )
    .run(REMOVED_FEATURE_QUESTION, Date.now());
  return res.changes;
}
