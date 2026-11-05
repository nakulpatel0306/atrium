import type { Database } from "bun:sqlite";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { changedFiles } from "../git";
import { resolvedAgent } from "../handoff";
import type { Space } from "../spaces";
import type { Task } from "../tasks";
import type { ActionFacts } from "./kinds";

// The branch a task's latest repo run started from, which is what its whole diff is measured against.
export function runStart(db: Database, taskId: string): string | null {
  const row = db
    .query("SELECT start_ref FROM runs WHERE task_id = ? AND start_ref IS NOT NULL ORDER BY started_at DESC, rowid DESC LIMIT 1")
    .get(taskId) as { start_ref: string } | null;
  return row?.start_ref ?? null;
}

// Read fresh from git every time, so a rule decides on what the branch holds now. Null (ask Nakul) when the
// branch, the repo or the run's start can't be read.
export async function factsFor(db: Database, task: Task, space: Space, filesKept = 0): Promise<ActionFacts | null> {
  const agent = resolvedAgent(db, task);
  if (space.kind === "general") return { domain: "general", agent, filesKept };
  const start = runStart(db, task.id);
  if (!space.repoPath || !task.branch || !start) return null;
  try {
    return { domain: "code", agent, branch: task.branch, files: await changedFiles(space.repoPath, start, task.branch) };
  } catch {
    return null;
  }
}

// What a folder holds, as one comparable string, so a run that wrote files into its space folder isn't taken
// for a text-only answer. Null when the folder can't be read, which callers treat as changed.
export function folderState(dir: string): string | null {
  try {
    const entries = (readdirSync(dir, { recursive: true }) as string[]).sort();
    return entries
      .map((name) => {
        const st = lstatSync(join(dir, name));
        return `${name}\0${st.mode}\0${st.size}\0${st.mtimeMs}`;
      })
      .join("\n");
  } catch {
    return null;
  }
}
