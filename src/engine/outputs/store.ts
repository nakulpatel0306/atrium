import type { Database } from "bun:sqlite";
import { newId } from "../ids";
import type { FileChange } from "./snapshot";

// One file a run created, changed or deleted. `space` paths are relative to the space folder (kept scratch files
// sit under runs/<runId>/); `branch` paths are repo-relative on branch `ref`.
export type RunFile = {
  id: string;
  runId: string;
  taskId: string;
  spaceId: string;
  root: "space" | "branch";
  ref: string | null;
  path: string;
  change: FileChange["change"];
  size: number | null;
  insertions: number | null;
  deletions: number | null;
  createdAt: number;
};

type Row = {
  id: string;
  run_id: string;
  task_id: string;
  space_id: string;
  root: RunFile["root"];
  ref: string | null;
  path: string;
  change: RunFile["change"];
  size: number | null;
  insertions: number | null;
  deletions: number | null;
  created_at: number;
};

export const RUN_FILES_CAP = 500;

const toFile = (r: Row): RunFile => ({
  id: r.id,
  runId: r.run_id,
  taskId: r.task_id,
  spaceId: r.space_id,
  root: r.root,
  ref: r.ref,
  path: r.path,
  change: r.change,
  size: r.size,
  insertions: r.insertions,
  deletions: r.deletions,
  createdAt: r.created_at,
});

const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

export function recordRunFiles(
  db: Database,
  run: { runId: string; taskId: string; spaceId: string; root: RunFile["root"]; ref?: string | null },
  changes: (FileChange & { insertions?: number | null; deletions?: number | null })[],
): number {
  const keep = [...changes].sort(byPath).slice(0, RUN_FILES_CAP);
  const now = Date.now();
  const insert = db.query(
    "INSERT INTO run_files (id, run_id, task_id, space_id, root, ref, path, change, size, insertions, deletions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  db.transaction(() => {
    for (const c of keep) {
      insert.run(newId("rf"), run.runId, run.taskId, run.spaceId, run.root, run.ref ?? null, c.path, c.change, c.size, c.insertions ?? null, c.deletions ?? null, now);
    }
  })();
  return keep.length;
}

// What a task made across all its runs: the newest change to each file, newest first.
export function taskFiles(db: Database, taskId: string): RunFile[] {
  const rows = db.query("SELECT * FROM run_files WHERE task_id = ? ORDER BY created_at DESC, path ASC").all(taskId) as Row[];
  const seen = new Set<string>();
  const out: RunFile[] = [];
  for (const r of rows) {
    const key = `${r.root}:${r.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(toFile(r));
  }
  return out;
}

// The task that last made or changed each file in a space, keyed `${root}:${path}`.
export function latestMakers(db: Database, spaceId: string): Map<string, { taskId: string; at: number }> {
  const rows = db
    .query("SELECT root, path, task_id, created_at FROM run_files WHERE space_id = ? AND change != 'deleted' ORDER BY created_at DESC, rowid DESC")
    .all(spaceId) as Pick<Row, "root" | "path" | "task_id" | "created_at">[];
  const out = new Map<string, { taskId: string; at: number }>();
  for (const r of rows) {
    const key = `${r.root}:${r.path}`;
    if (!out.has(key)) out.set(key, { taskId: r.task_id, at: r.created_at });
  }
  return out;
}

// One plain sentence per kind of change, for the review: "Made 3 files: a.md, b.md and c.md."
export function madeLine(changes: FileChange[], display: (path: string) => string = (p) => p): string | null {
  const sorted = [...changes].sort(byPath);
  const parts = (
    [
      ["created", "Made"],
      ["changed", "Changed"],
      ["deleted", "Deleted"],
    ] as const
  )
    .map(([change, verb]) => said(verb, sorted.filter((c) => c.change === change).map((c) => display(c.path))))
    .filter((s): s is string => s !== null);
  return parts.length ? parts.join(" ") : null;
}

function said(verb: string, names: string[]): string | null {
  if (!names.length) return null;
  if (names.length === 1) return `${verb} ${names[0]}.`;
  const shown = names.length > 4 ? [...names.slice(0, 3), `${names.length - 3} more`] : names;
  return `${verb} ${names.length} files: ${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}.`;
}
