import type { Database } from "bun:sqlite";
import { newId } from "./ids";

export type EngineEvent =
  | { type: "changed" }
  | { type: "run-output"; runId: string; taskId: string; chunk: string };

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
  actor: string;
  message: string;
  createdAt: number;
};

export function logActivity(db: Database, spaceId: string | null, actor: string, message: string): void {
  db.query("INSERT INTO activity (id, space_id, actor, message, created_at) VALUES (?, ?, ?, ?, ?)").run(
    newId("act"),
    spaceId,
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
      `SELECT id, space_id, actor, message, created_at FROM activity ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(...params) as { id: string; space_id: string | null; actor: string; message: string; created_at: number }[];
  return rows.map((r) => ({
    id: r.id,
    spaceId: r.space_id,
    actor: r.actor,
    message: r.message,
    createdAt: r.created_at,
  }));
}
