import type { Database } from "bun:sqlite";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { getApproval } from "../approvals";
import { spaceFolder, tildePath } from "../folders";
import { git } from "../git";
import { getSpace, type Space } from "../spaces";
import { getTask } from "../tasks";
import { type FileKind, kindOf } from "./files";
import { snapshotFolder } from "./snapshot";
import { latestMakers, taskFiles } from "./store";
import type { Outcome } from "../outcome";

// What the dashboard, terminal app and (later) the conversation read about a task's results and a space's folder.

export type OutputFile = {
  id: string;
  runId: string;
  root: "space" | "branch";
  ref: string | null;
  path: string;
  absPath: string;
  change: "created" | "changed" | "deleted";
  size: number | null;
  insertions: number | null;
  deletions: number | null;
  kind: FileKind;
  exists: boolean;
  at: number;
};

export type TaskOutputs = {
  // `outcome` is what the agent said about the task, so an accepted "couldn't" never reads as a plain approval.
  summary: { text: string; status: "pending" | "approved" | "rejected"; decidedBy: "you" | "rule"; at: number; outcome?: Outcome | null } | null;
  files: OutputFile[];
};

export type SpaceFile = {
  root: "space" | "branch";
  ref: string | null;
  path: string;
  absPath: string;
  size: number;
  at: number;
  kind: FileKind;
  madeBy: { taskId: string; title: string } | null;
};

// `shown` is the folder as Nakul would type it ("~/Atrium/weekly-planning").
export type SpaceFiles = { folder: string | null; shown: string | null; files: SpaceFile[]; truncated: boolean };

const isFileOnDisk = (abs: string) => {
  try {
    return lstatSync(abs).isFile();
  } catch {
    return false;
  }
};

// Every path on a branch, read once per branch: a task can list hundreds of files, and each refresh asks again.
async function branchPaths(repo: string | null, ref: string): Promise<Set<string>> {
  if (repo === null) return new Set();
  const res = await git(repo, ["-c", "core.quotePath=false", "ls-tree", "-r", "-z", "--name-only", ref]).catch(() => null);
  return new Set(res && res.code === 0 ? res.out.split("\0").filter(Boolean) : []);
}

// The newest review of the task (whatever was decided) is its summary; files are the newest change to each.
export async function taskOutputs(db: Database, taskId: string): Promise<TaskOutputs | null> {
  const task = getTask(db, taskId);
  const space = task ? getSpace(db, task.spaceId) : null;
  if (!task || !space) return null;
  const row = db
    .query("SELECT id FROM approvals WHERE task_id = ? AND kind = 'review' ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .get(taskId) as { id: string } | null;
  const a = row ? getApproval(db, row.id) : null;
  const summary = a ? { text: a.detail, status: a.status, decidedBy: a.decidedBy, at: a.resolvedAt ?? a.createdAt, outcome: task.outcome } : null;
  const rows = taskFiles(db, taskId);
  const onBranch = new Map<string, Set<string>>();
  for (const ref of new Set(rows.flatMap((f) => (f.root === "branch" && f.ref ? [f.ref] : [])))) onBranch.set(ref, await branchPaths(space.repoPath, ref));
  const files = rows.map((f): OutputFile => {
    const absPath = f.root === "space" ? join(spaceFolder(space), f.path) : join(space.repoPath ?? "", f.path);
    const exists = f.change !== "deleted" && (f.root === "space" ? isFileOnDisk(absPath) : (onBranch.get(f.ref!)?.has(f.path) ?? false));
    return {
      id: f.id,
      runId: f.runId,
      root: f.root,
      ref: f.ref,
      path: f.path,
      absPath,
      change: f.change,
      size: f.size,
      insertions: f.insertions,
      deletions: f.deletions,
      kind: kindOf(f.path),
      exists,
      at: f.createdAt,
    };
  });
  return { summary, files };
}

// The folder as it is now, credited to the newest task that touched each file. A repo space lists what its
// tasks changed on their branches instead, since the working copy is Nakul's.
export async function spaceFiles(db: Database, spaceId: string): Promise<SpaceFiles | null> {
  const space = getSpace(db, spaceId);
  if (!space) return null;
  const titles = new Map<string, string>();
  const madeBy = (taskId: string) => {
    if (!titles.has(taskId)) titles.set(taskId, getTask(db, taskId)?.title ?? "");
    return { taskId, title: titles.get(taskId)! };
  };
  if (space.kind === "repo") return repoFiles(db, space, madeBy);
  const folder = spaceFolder(space);
  // Listing only: no hashes, which would read every file on each refresh.
  const snap = snapshotFolder(folder, { limits: { hashBytes: -1 } });
  const makers = latestMakers(db, space.id);
  const files = [...snap.files]
    .map(([path, e]): SpaceFile => {
      const maker = makers.get(`space:${path}`);
      return { root: "space", ref: null, path, absPath: join(folder, path), size: e.size, at: e.mtimeMs, kind: kindOf(path), madeBy: maker ? madeBy(maker.taskId) : null };
    })
    .sort((a, b) => b.at - a.at);
  return { folder, shown: tildePath(folder), files, truncated: snap.truncated };
}

function repoFiles(db: Database, space: Space, madeBy: (taskId: string) => { taskId: string; title: string }): SpaceFiles {
  const rows = db
    .query("SELECT task_id, ref, path, change, size, created_at FROM run_files WHERE space_id = ? AND root = 'branch' ORDER BY created_at DESC, rowid DESC")
    .all(space.id) as { task_id: string; ref: string; path: string; change: string; size: number | null; created_at: number }[];
  const seen = new Set<string>();
  const files: SpaceFile[] = [];
  for (const r of rows) {
    if (seen.has(r.path)) continue;
    seen.add(r.path);
    if (r.change === "deleted") continue;
    files.push({
      root: "branch",
      ref: r.ref,
      path: r.path,
      absPath: join(space.repoPath ?? "", r.path),
      size: r.size ?? 0,
      at: r.created_at,
      kind: kindOf(r.path),
      madeBy: madeBy(r.task_id),
    });
  }
  return { folder: space.repoPath, shown: space.repoPath && tildePath(space.repoPath), files, truncated: false };
}
