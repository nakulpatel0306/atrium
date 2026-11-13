import type { Database } from "bun:sqlite";

// Tables of features Atrium no longer has. A fresh install never creates them, but an older database still holds
// them, and their rows point at spaces, tasks and approvals. Nothing reads them any more; the only thing that
// touches them is a delete the user asks for, which has to clear them or the foreign keys would refuse it.
export const LEGACY = {
  // Rows keyed by space, children before parents.
  bySpace: ["mail_actions"],
  // Rows that mention a task and keep their own row when it goes.
  byTask: ["mail_actions"],
  // Rows that belong to one approval and go with it.
  byApproval: ["mail_actions"],
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
