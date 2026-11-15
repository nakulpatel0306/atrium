// The first-run sample: a tiny bun project with one failing test, bundled with Atrium and copied to a temp folder,
// so a new user can watch the whole loop once on their own Claude CLI without pointing it at their own code.
import type { Database } from "bun:sqlite";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { git } from "./git";
import { newLoop, SIZE_BUDGETS } from "./loop";
import { getSetting, setSetting } from "./settings";
import { createSpace, type Space, updateSpace } from "./spaces";
import { createTask, setTaskLoop, type Task } from "./tasks";

export const SAMPLE_ASK = "Fix the failing cart test";
const SAMPLE_KEY = "sample.spaceIds";
const REPO = resolve(import.meta.dir, "..", "..", "assets", "sample-repo");

// Shown before it starts, so nobody is surprised. A real run on the cheap tier (haiku, Claude Code 2.1.323) took 52
// seconds and about 1¢ at list prices from brief to ready, review round and walkthrough included; this leaves room.
export const SAMPLE_ESTIMATE = { cents: 2, seconds: 60 };

export function isSampleSpace(db: Database, spaceId: string): boolean {
  return sampleIds(db).includes(spaceId);
}

function sampleIds(db: Database): string[] {
  try {
    const v = JSON.parse(getSetting(db, SAMPLE_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

async function run(cwd: string, args: string[]): Promise<void> {
  const res = await git(cwd, args);
  if (res.code !== 0) throw new Error(`Couldn't set up the sample repo (git ${args[0]}): ${res.err.trim()}`);
}

export async function startSample(db: Database): Promise<{ space: Space; task: Task }> {
  const dir = mkdtempSync(join(tmpdir(), "atrium-sample-"));
  cpSync(REPO, dir, { recursive: true });
  await run(dir, ["init", "-q", "-b", "main"]);
  // A throwaway repo of Atrium's own: its first commit needs no signing key and no identity of the user's.
  await run(dir, ["config", "user.name", "Atrium sample"]);
  await run(dir, ["config", "user.email", "sample@example.com"]);
  await run(dir, ["config", "commit.gpgsign", "false"]);
  await run(dir, ["add", "-A"]);
  await run(dir, ["commit", "-q", "-m", "Start the sample"]);
  const space = createSpace(db, { name: "Sample cart", kind: "repo", goal: "A tiny bundled repo with one failing test, to watch the loop once", repoPath: dir, private: true });
  updateSpace(db, space.id, { reviewBy: "claude", learning: "light" });
  setSetting(db, SAMPLE_KEY, JSON.stringify([...sampleIds(db), space.id]));
  // Run it is the user's click to run now: on battery, and in Claude's reserved window, so the first run never waits
  // for a charger or a window reset. Its review inherits the window (handoff.ts).
  const task = createTask(db, { spaceId: space.id, title: SAMPLE_ASK, detail: SAMPLE_ASK, weight: "heavy", allowOnBattery: true, ignoreReserve: true, agent: "claude" });
  return { space: { ...space, reviewBy: "claude", learning: "light" }, task: setTaskLoop(db, task.id, { ...newLoop(SIZE_BUDGETS.small), stage: "brief" }) };
}
