import type { Database } from "bun:sqlite";
import { isStep, STEPS, type Progress, type Step } from "./start-steps";
import { getSetting, setSetting } from "./settings";
import { listSpaces } from "./spaces";

const STEP_KEY = "start.step";
const SKIPPED_KEY = "start.skipped";
const DONE_KEY = "start.done";
const DISMISSED_KEY = "start.dismissed";

export function getProgress(db: Database): Progress {
  const step = getSetting(db, STEP_KEY);
  let skipped: Step[] = [];
  try {
    const raw = JSON.parse(getSetting(db, SKIPPED_KEY) ?? "[]");
    if (Array.isArray(raw)) skipped = raw.filter(isStep);
  } catch {
    // A mangled value starts the list over.
  }
  return { step: isStep(step) ? step : "welcome", skipped, done: getSetting(db, DONE_KEY) === "1", dismissed: getSetting(db, DISMISSED_KEY) === "1" };
}

export function saveProgress(db: Database, change: { step?: unknown; skip?: unknown; unskip?: unknown; done?: unknown; dismiss?: unknown }, claudeProblem: string | null): Progress {
  const now = getProgress(db);
  let { step, skipped } = now;
  if (change.step !== undefined) {
    if (!isStep(change.step)) throw new Error("That isn't a step of Get started.");
    // Stepping onto Done is finishing, so it follows the same rule.
    if (change.step === "done" && claudeProblem) throw new Error(`Claude comes first: ${claudeProblem}`);
    step = change.step;
  }
  // Agents can't be skipped, since Claude is required.
  if (isStep(change.skip) && change.skip !== "agents" && !skipped.includes(change.skip)) skipped = [...skipped, change.skip];
  if (isStep(change.unskip)) skipped = skipped.filter((s) => s !== change.unskip);
  if (change.done === true) {
    if (claudeProblem) throw new Error(`Claude comes first: ${claudeProblem}`);
    setSetting(db, DONE_KEY, "1");
    step = "done";
  }
  if (typeof change.dismiss === "boolean") setSetting(db, DISMISSED_KEY, change.dismiss ? "1" : "0");
  setSetting(db, STEP_KEY, step);
  setSetting(db, SKIPPED_KEY, JSON.stringify(skipped));
  return getProgress(db);
}

// The wizard opens by itself only on a fresh engine that hasn't finished it or been told "Skip for now". Once a
// space exists a skip lapses, so it opens again if every space is later deleted; reopening from Settings clears it too.
export function shouldAutoOpen(db: Database): boolean {
  const progress = getProgress(db);
  if (listSpaces(db).length > 0) {
    if (progress.dismissed) setSetting(db, DISMISSED_KEY, "0");
    return false;
  }
  return !progress.done && !progress.dismissed;
}
