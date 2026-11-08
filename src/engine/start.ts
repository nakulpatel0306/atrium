import type { Database } from "bun:sqlite";
import { isStep, STEPS, type Progress, type Step } from "./start-steps";
import { getSetting, setSetting } from "./settings";
import { listSpaces } from "./spaces";

const STEP_KEY = "start.step";
const SKIPPED_KEY = "start.skipped";
const DONE_KEY = "start.done";

export function getProgress(db: Database): Progress {
  const step = getSetting(db, STEP_KEY);
  let skipped: Step[] = [];
  try {
    const raw = JSON.parse(getSetting(db, SKIPPED_KEY) ?? "[]");
    if (Array.isArray(raw)) skipped = raw.filter(isStep);
  } catch {
    // A mangled value starts the list over.
  }
  return { step: isStep(step) ? step : "welcome", skipped, done: getSetting(db, DONE_KEY) === "1" };
}

export function saveProgress(db: Database, change: { step?: unknown; skip?: unknown; unskip?: unknown; done?: unknown }, claudeProblem: string | null): Progress {
  const now = getProgress(db);
  let { step, skipped } = now;
  if (change.step !== undefined) {
    if (!isStep(change.step)) throw new Error("That isn't a step of Get started.");
    // Stepping onto Done is finishing, so it follows the same rule.
    if (change.step === "done" && claudeProblem) throw new Error(`Claude Code comes first: ${claudeProblem}`);
    step = change.step;
  }
  // Agents can't be skipped, since Claude is required.
  if (isStep(change.skip) && change.skip !== "agents" && !skipped.includes(change.skip)) skipped = [...skipped, change.skip];
  if (isStep(change.unskip)) skipped = skipped.filter((s) => s !== change.unskip);
  if (change.done === true) {
    if (claudeProblem) throw new Error(`Claude Code comes first: ${claudeProblem}`);
    setSetting(db, DONE_KEY, "1");
    step = "done";
  }
  setSetting(db, STEP_KEY, step);
  setSetting(db, SKIPPED_KEY, JSON.stringify(skipped));
  return getProgress(db);
}

// The wizard opens by itself only on a fresh engine that hasn't finished it.
export const shouldAutoOpen = (db: Database): boolean => listSpaces(db).length === 0 && !getProgress(db).done;
