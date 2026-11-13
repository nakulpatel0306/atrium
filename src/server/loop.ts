import type { Database } from "bun:sqlite";
import type { AgentAdapter } from "../engine/agents/types";
import { gapHints, normalizeBrief } from "../engine/brief";
import { draftBrief } from "../engine/brief-draft";
import { checksFor, detectChecks } from "../engine/checks/detect";
import { latestChecks } from "../engine/checks/run";
import { git } from "../engine/git";
import { type Budget, type LoopState, resumed } from "../engine/loop";
import { getSpace, type Space } from "../engine/spaces";
import { appendTaskDetail, getTask, setTaskBrief, setTaskLoop, setTaskStatus, type Task } from "../engine/tasks";
import { tierModel } from "../engine/tiers";
import { HttpError, json, readBody, str } from "./http";

const ASK_MAX = 4000;
export const HINT_MAX = 2000;

// A budget as sent: whole tokens and minutes, within limits that keep a typo from meaning "forever".
export function budgetField(v: unknown): Budget {
  const b = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const ok = (n: unknown, max: number) => typeof n === "number" && Number.isInteger(n) && n > 0 && n <= max;
  if (!ok(b.tokens, 50_000_000) || !ok(b.minutes, 24 * 60)) throw new HttpError(400, "A budget needs whole tokens (up to 50,000,000) and minutes (up to 1,440).");
  return { tokens: b.tokens as number, minutes: b.minutes as number };
}

// The commands the gate would run in this space now, for the brief's gap hints; empty when the repo can't be read.
async function spaceChecks(space: Space): Promise<string[]> {
  if (space.kind !== "repo" || !space.repoPath) return [];
  try {
    const head = await git(space.repoPath, ["rev-parse", "--verify", "HEAD^{commit}"]);
    const found = head.code === 0 ? await detectChecks(space.repoPath, head.out.trim()) : [];
    return checksFor(found, { spaceChecks: space.checks, verify: null }).map((c) => c.command);
  } catch {
    return [];
  }
}

const pausedTask = (db: Database, id: string): Task & { loop: LoopState } => {
  const task = getTask(db, id);
  if (!task) throw new HttpError(404, "No such task.");
  if (task.status !== "blocked" || !task.loop?.paused) throw new HttpError(409, "This task isn't paused, so there's nothing to resume.");
  return task as Task & { loop: LoopState };
};

// The brief pre-pass, the checks a task's badge speaks for, budgets, and the two ways on from a pause.
// Returns null for paths it doesn't own.
export async function loopRoute(db: Database, claude: AgentAdapter | undefined, kick: () => void, req: Request, url: URL): Promise<Response | null> {
  const { pathname } = url;
  const method = req.method;

  if (method === "POST" && pathname === "/api/brief") {
    const b = await readBody(req);
    const space = getSpace(db, str(b.spaceId, "spaceId"));
    if (!space) throw new HttpError(404, "No such space.");
    const ask = str(b.text, "text").trim();
    if (!ask) throw new HttpError(400, "Say what you want done first.");
    if (ask.length > ASK_MAX) throw new HttpError(400, `Keep the ask to ${ASK_MAX.toLocaleString("en-US")} characters or fewer.`);
    if (!claude) throw new HttpError(503, "Claude isn't set up, so Atrium can't draft a brief. Send the task as it is with ⌘↩.");
    const repo = space.kind === "repo" ? space.repoPath : null;
    const [draft, checks] = await Promise.all([
      draftBrief(claude, { ask, repoPath: repo, privateData: space.private, model: tierModel(db, "cheap") || undefined, signal: req.signal }),
      spaceChecks(space),
    ]);
    return json({ ...draft, checks, hints: gapHints(draft.brief, { repo: space.kind === "repo", checksFound: checks.length > 0 }) });
  }

  const checksM = method === "GET" ? pathname.match(/^\/api\/tasks\/([^/]+)\/checks$/) : null;
  if (checksM) {
    if (!getTask(db, checksM[1]!)) throw new HttpError(404, "No such task.");
    return json(latestChecks(db, checksM[1]!));
  }

  const budgetM = method === "POST" ? pathname.match(/^\/api\/tasks\/([^/]+)\/budget$/) : null;
  if (budgetM) {
    const task = getTask(db, budgetM[1]!);
    if (!task?.loop) throw new HttpError(404, "No such task with a budget.");
    if (task.status === "done") throw new HttpError(409, "This task is finished, so its budget no longer applies.");
    const next = setTaskLoop(db, task.id, { ...task.loop, budget: budgetField((await readBody(req)).budget) });
    kick();
    return json(next);
  }

  // A hint carries on from the branch with the note, like a steer; the loop's counters and budget start over.
  const hintM = method === "POST" ? pathname.match(/^\/api\/tasks\/([^/]+)\/hint$/) : null;
  if (hintM) {
    const task = pausedTask(db, hintM[1]!);
    const note = str((await readBody(req)).note, "note").trim();
    if (!note) throw new HttpError(400, "Write a hint for the agent first.");
    if (note.length > HINT_MAX) throw new HttpError(400, `Keep the hint to ${HINT_MAX.toLocaleString("en-US")} characters or fewer.`);
    appendTaskDetail(db, task.id, `\n\nHint from you after a pause: ${note}\nThe changes made so far are already on this branch. Continue from them; don't start over.`);
    setTaskLoop(db, task.id, resumed(task.loop));
    const next = setTaskStatus(db, task.id, "queued");
    kick();
    return json(next);
  }

  // Taking the pre-pass's suggested check command is the user's edit, and from then on the gate runs it.
  const verifyM = method === "POST" ? pathname.match(/^\/api\/tasks\/([^/]+)\/accept-verify$/) : null;
  if (verifyM) {
    const task = getTask(db, verifyM[1]!);
    if (!task?.brief || !task.loop?.suggestedVerify || task.status === "done") throw new HttpError(409, "This task has no suggested check to use.");
    setTaskBrief(db, task.id, { ...task.brief, verify: task.loop.suggestedVerify });
    return json(setTaskLoop(db, task.id, { ...task.loop, suggestedVerify: null }));
  }

  // The answers to a brief's questions go with it, and the writer starts. Sending none skips them.
  const answersM = method === "POST" ? pathname.match(/^\/api\/tasks\/([^/]+)\/answers$/) : null;
  if (answersM) {
    const task = getTask(db, answersM[1]!);
    if (!task?.brief || !task.loop?.questions.length || task.status !== "queued") throw new HttpError(409, "This task has no questions waiting for you.");
    const answers = normalizeBrief({ answers: (await readBody(req)).answers }).answers.filter((a) => task.loop!.questions.some((q) => q.question === a.question));
    setTaskBrief(db, task.id, { ...task.brief, answers });
    const next = setTaskLoop(db, task.id, { ...task.loop, questions: [], stage: "writing" });
    kick();
    return json(next);
  }

  // One read-only run that says what's wrong, instead of another attempt; the task stays paused after it.
  const explainM = method === "POST" ? pathname.match(/^\/api\/tasks\/([^/]+)\/explain$/) : null;
  if (explainM) {
    const task = pausedTask(db, explainM[1]!);
    setTaskLoop(db, task.id, { ...task.loop, explain: true, explanation: null });
    const next = setTaskStatus(db, task.id, "queued");
    kick();
    return json(next);
  }
  return null;
}
