import type { Database } from "bun:sqlite";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { branchSha, changedFiles, changedText, fileAt, treeEntries } from "../git";
import { resolvedAgent } from "../handoff";
import type { Space } from "../spaces";
import type { Task } from "../tasks";
import {
  type ActionFacts,
  bodyRuns,
  enablesDoctest,
  hasImport,
  isAgentConfig,
  isAgentInstructionFile,
  isDoctestConfig,
  isSiteConfig,
  MEDIUM_LINES,
} from "./kinds";

// The branch a task's latest repo run started from, which is what its whole diff is measured against.
export function runStart(db: Database, taskId: string): string | null {
  const row = db
    .query("SELECT start_ref FROM runs WHERE task_id = ? AND start_ref IS NOT NULL ORDER BY started_at DESC, rowid DESC LIMIT 1")
    .get(taskId) as { start_ref: string } | null;
  return row?.start_ref ?? null;
}

// Read fresh from git every time, and all at one commit, so a rule decides on exactly what it classified. Null
// (ask Nakul) when the branch, the repo or the run's start can't be read.
export async function factsFor(db: Database, task: Task, space: Space, filesKept = 0): Promise<ActionFacts | null> {
  const agent = resolvedAgent(db, task);
  if (space.kind === "general") return { domain: "general", agent, filesKept };
  const start = runStart(db, task.id);
  if (!space.repoPath || !task.branch || !start) return null;
  const repo = space.repoPath;
  try {
    const sha = await branchSha(repo, task.branch);
    if (!sha) return null;
    const files = await changedFiles(repo, start, sha);
    const text = await changedText(repo, start, sha);
    const tree = await treeEntries(repo, sha);
    // Blunt on purpose: docs rules are only for plain repos. Any doubt about what runs Markdown or what an agent's
    // instructions pull in closes the repo to them, instead of trying to resolve exactly which files are affected.
    const notPlain = tree.some((e) => e.mode === "120000" || e.mode === "160000" || isAgentConfig(e.path));
    let siteConfig = tree.some((e) => isSiteConfig(e.path));
    for (const e of tree.filter((e) => !siteConfig && isDoctestConfig(e.path))) {
      const file = e.mode === "100644" ? await fileAt(repo, sha, e.path) : null;
      if (!file || file.truncated || enablesDoctest(file.text)) siteConfig = true;
    }
    // More files than a docs kind allows lines can never be docs, so they aren't read.
    let bodyUnsafe = files.length > MEDIUM_LINES;
    for (const f of bodyUnsafe ? [] : files.filter((f) => f.status !== "D")) {
      const file = await fileAt(repo, sha, f.path);
      if (file.truncated || bodyRuns(file.text)) {
        bodyUnsafe = true;
        break;
      }
    }
    let instructionsUnsafe = false;
    for (const e of tree.filter((e) => isAgentInstructionFile(e.path))) {
      if (e.mode !== "100644") instructionsUnsafe = true;
      else {
        const file = await fileAt(repo, sha, e.path);
        if (file.truncated || hasImport(file.text)) instructionsUnsafe = true;
      }
      if (instructionsUnsafe) break;
    }
    const content = { added: text.added, bytes: text.bytes, siteConfig, instructionsUnsafe, notPlain, bodyUnsafe };
    return { domain: "code", agent, branch: task.branch, sha, files, content };
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
