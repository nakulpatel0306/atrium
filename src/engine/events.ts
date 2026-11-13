import type { Database } from "bun:sqlite";
import { newId } from "./ids";

export type EngineEvent =
  | { type: "changed" }
  // seq counts a run's lines from 1, so a reader that loaded the transcript can tell which lines it already has.
  | { type: "run-output"; runId: string; taskId: string; chunk: string; seq?: number }
  // A running repo task's files changed; the dashboard reads its changes again. Throttled per task (diff-watch.ts).
  | { type: "diff-changed"; taskId: string };

const listeners = new Set<(e: EngineEvent) => void>();

export const bus = {
  on(fn: (e: EngineEvent) => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  emit(e: EngineEvent): void {
    for (const fn of [...listeners]) fn(e);
  },
};

export type ActivityRow = {
  id: string;
  spaceId: string | null;
  // Null for lines that aren't about one task, and for lines logged before tasks were recorded.
  taskId: string | null;
  actor: string;
  message: string;
  createdAt: number;
};

// A line can arrive after its space or task was deleted (a lookup or clone that finished late). It's still worth
// recording, so it keeps its words and drops the links that would no longer hold.
export function logActivity(db: Database, spaceId: string | null, actor: string, message: string, about: { taskId?: string | null } = {}): void {
  const space = spaceId && db.query("SELECT 1 FROM spaces WHERE id = ?").get(spaceId) ? spaceId : null;
  const task = about.taskId && db.query("SELECT 1 FROM tasks WHERE id = ?").get(about.taskId) ? about.taskId : null;
  db.query("INSERT INTO activity (id, space_id, task_id, actor, message, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    newId("act"),
    space,
    task,
    actor,
    message,
    Date.now(),
  );
  bus.emit({ type: "changed" });
}

export function listActivity(db: Database, opts: { spaceId?: string; limit?: number } = {}): ActivityRow[] {
  const where = opts.spaceId ? "WHERE space_id = ?" : "";
  const params = opts.spaceId ? [opts.spaceId, opts.limit ?? 100] : [opts.limit ?? 100];
  // rowid breaks ties between rows logged in the same millisecond
  const rows = db
    .query(
      `SELECT id, space_id, task_id, actor, message, created_at FROM activity ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(...params) as { id: string; space_id: string | null; task_id: string | null; actor: string; message: string; created_at: number }[];
  return rows.map((r) => ({
    id: r.id,
    spaceId: r.space_id,
    taskId: r.task_id,
    actor: r.actor,
    message: r.message,
    createdAt: r.created_at,
  }));
}
