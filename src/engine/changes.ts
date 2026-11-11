import type { Database } from "bun:sqlite";
import { totalsOf, type DiffResult } from "./diff-parse";
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

// A repo task's changes for the Changes view. While it runs they're read from the working tree, since the agent
// leaves its edits uncommitted until the run ends; once it's done they're the branch's commits.
export async function taskChanges(db: Database, taskId: string): Promise<DiffResult> {
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
    const started = db.query("SELECT started_at FROM runs WHERE task_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1").get(task.id) as { started_at: number } | null;
    return workingDiff(path, base, { since: started?.started_at });
  }
  if (!(await branchSha(path, task.branch))) {
    throw new ChangesRefused(404, `The branch ${task.branch} isn't in the repo anymore, so there are no changes to show.`);
  }
  return branchDiff(path, base, task.branch);
}
