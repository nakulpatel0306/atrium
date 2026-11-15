// The first-run sample: a tiny bun project with one failing test, bundled with Atrium and copied into Atrium's own
// folder, so a new user can watch the whole loop once on their own Claude CLI without pointing it at their own code.
import type { Database } from "bun:sqlite";
import { cpSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { config } from "./config";
import { git } from "./git";
import { newId } from "./ids";
import { newLoop, SIZE_BUDGETS } from "./loop";
import { getSetting, setSetting } from "./settings";
import { createSpace, getSpace, listSpaces, type Space, updateSpace } from "./spaces";
import { createTask, listTasks, setTaskLoop, type Task } from "./tasks";

export const SAMPLE_ASK = "Fix the failing cart test";
const SAMPLE_KEY = "sample.spaceIds";
const REPO = resolve(import.meta.dir, "..", "..", "assets", "sample-repo");

// Shown before it starts, so nobody is surprised. Real runs on the cheap tier (haiku, Claude Code 2.1.323) took 30 to 52
// seconds and under 1¢ at list prices from brief to ready, review and walkthrough included; this leaves room.
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

// Where the copies live: inside Atrium's data folder, which has few neighbours (a sandbox lists what's beside a repo)
// and which macOS never purges the way it purges the temp folder.
export const samplesDir = () => join(config().home, "samples");

// Atrium's own throwaway commits run none of the user's hooks or templates.
async function run(cwd: string, args: string[]): Promise<void> {
  const res = await git(cwd, ["-c", "core.hooksPath=/dev/null", ...args]);
  if (res.code !== 0) throw new Error(`Couldn't set up the sample repo (git ${args[0]}): ${res.err.trim()}`);
}

export async function startSample(db: Database): Promise<{ space: Space; task: Task }> {
  // A second click while the first sample is still going (a double-click, a second tab) gets that one back.
  for (const id of sampleIds(db)) {
    const open = listTasks(db, { status: ["queued", "running", "review", "blocked"] }).find((t) => t.spaceId === id && t.kind === "work");
    const space = getSpace(db, id);
    if (open && space) return { space, task: open };
  }
  const dir = join(samplesDir(), newId("sample"));
  mkdirSync(samplesDir(), { recursive: true });
  cpSync(REPO, dir, { recursive: true });
  await run(dir, ["init", "-q", "-b", "main", "--template="]);
  // A throwaway repo of Atrium's own: its first commit needs no signing key and no identity of the user's.
  await run(dir, ["config", "user.name", "Atrium sample"]);
  await run(dir, ["config", "user.email", "sample@example.com"]);
  await run(dir, ["config", "commit.gpgsign", "false"]);
  await run(dir, ["add", "-A"]);
  await run(dir, ["commit", "-q", "--no-verify", "-m", "Start the sample"]);
  // Not private: nothing in a bundled toy repo needs keeping from other agents.
  const space = createSpace(db, { name: "Sample cart", kind: "repo", goal: "A tiny bundled repo with one failing test, to watch the loop once", repoPath: dir, private: false });
  updateSpace(db, space.id, { reviewBy: "claude", learning: "light" });
  setSetting(db, SAMPLE_KEY, JSON.stringify([...sampleIds(db), space.id]));
  // Run it is the user's click to run now: on battery, and in Claude's reserved window, so the first run never waits
  // for a charger or a window reset. Its review inherits the window (handoff.ts).
  const task = createTask(db, { spaceId: space.id, title: SAMPLE_ASK, detail: SAMPLE_ASK, weight: "heavy", allowOnBattery: true, ignoreReserve: true, agent: "claude" });
  return { space: getSpace(db, space.id)!, task: setTaskLoop(db, task.id, { ...newLoop(SIZE_BUDGETS.small), stage: "brief" }) };
}

// The copy under the samples folder, if this space is a sample; anything else is never Atrium's to remove.
export function sampleFolder(space: Space | null): string | null {
  const path = space?.repoPath;
  return path && path.startsWith(samplesDir() + "/") && !path.slice(samplesDir().length + 1).includes("/") ? path : null;
}

const ORPHAN_AGE_MS = 60_000;

// Copies no space points at any more: left by a delete the engine didn't get to finish.
export function removeOrphanSamples(db: Database): void {
  let names: string[];
  try {
    names = readdirSync(samplesDir());
  } catch {
    return;
  }
  const used = new Set(listSpaces(db, { includeArchived: true }).map((s) => s.repoPath));
  for (const name of names) {
    const path = join(samplesDir(), name);
    // A copy from the last minute may belong to a Run it click still between copying and creating its space.
    if (used.has(path) || statSync(path).mtimeMs > Date.now() - ORPHAN_AGE_MS) continue;
    rmSync(path, { recursive: true, force: true });
  }
}
