import type { Database } from "bun:sqlite";
import { totalsOf, type DiffResult } from "./diff-parse";
import { bus } from "./events";
import { branchDiff, branchSha, gitSettingsFingerprint, headRef, workingDiff } from "./git";
import { lastRepoRun } from "./runner";
import { getSpace } from "./spaces";
import { getTask } from "./tasks";

export class ChangesRefused extends Error {
  constructor(
    readonly status: 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "ChangesRefused";
  }
}

const NONE: DiffResult = { files: [], totals: totalsOf([]), truncated: false };

// A running task's read hashes up to 50 MB, so reads never pile up: one at a time per task, with callers asking
// about the same state sharing it, and the answer kept briefly for the next caller. The state is the task row plus the count of
// diff-changed events seen for it.
const CACHE_MS = 1000;
const edits = new Map<string, number>();
const reading = new Map<string, { key: string; result: Promise<DiffResult> }>();
const recent = new Map<string, { key: string; at: number; result: DiffResult }>();
bus.on((e) => {
  if (e.type === "diff-changed") edits.set(e.taskId, (edits.get(e.taskId) ?? 0) + 1);
});

export async function taskChanges(db: Database, taskId: string): Promise<DiffResult> {
  const task = getTask(db, taskId);
  const key = `${task?.status}:${task?.updatedAt}:${edits.get(taskId) ?? 0}`;
  const kept = recent.get(taskId);
  // Only a running task's read is costly enough to keep; a finished one is a quick diff of two commits.
  if (task?.status === "running" && kept && kept.key === key && Date.now() - kept.at < CACHE_MS) return kept.result;
  const current = reading.get(taskId);
  if (current?.key === key) return current.result;
  // A read of an older state finishes first; then this one starts, unless another caller already started it.
  if (current) {
    await current.result.catch(() => {});
    return taskChanges(db, taskId);
  }
  const result = readChanges(db, taskId);
  reading.set(taskId, { key, result });
  try {
    const value = await result;
    recent.set(taskId, { key, at: Date.now(), result: value });
    return value;
  } finally {
    if (reading.get(taskId)?.result === result) reading.delete(taskId);
  }
}

// A repo task's changes for the Changes view. While it runs they're read from the working tree, since the agent
// leaves its edits uncommitted until the run ends; once it's done they're the branch's commits.
async function readChanges(db: Database, taskId: string): Promise<DiffResult> {
  const task = getTask(db, taskId);
  const space = task ? getSpace(db, task.spaceId) : null;
  if (!task || space?.kind !== "repo" || !space.repoPath) throw new ChangesRefused(404, "Only tasks in a repo space have changes to show.");
  const run = lastRepoRun(db, task.id);
  if (!task.branch || !run) return NONE;
  // A fix counts from where its parent's work began, as its review does.
  const base = (task.kind === "fix" && task.parentTaskId && lastRepoRun(db, task.parentTaskId)?.start) || run.start;
  const path = space.repoPath;
  const head = await headRef(path).catch(() => null);
  if (task.status === "running" && head?.branch === task.branch) {
    // Reading the working tree could run something the agent planted in the repo's git settings.
    if (!run.fingerprint || (await gitSettingsFingerprint(path).catch(() => null)) !== run.fingerprint) {
      throw new ChangesRefused(409, "The agent changed this repo's git settings, so Atrium won't read its changes. Atrium checks them when the run ends.");
    }
    return workingDiff(path, base);
  }
  if (!(await branchSha(path, task.branch))) {
    throw new ChangesRefused(404, `The branch ${task.branch} isn't in the repo anymore, so there are no changes to show.`);
  }
  return branchDiff(path, base, task.branch);
}
