import type { Database } from "bun:sqlite";
import type { AgentAdapter } from "../engine/agents/types";
import { type Brief, gapHints, normalizeBrief } from "../engine/brief";
import { draftBrief } from "../engine/brief-draft";
import { checksFor, detectChecks } from "../engine/checks/detect";
import { latestChecks } from "../engine/checks/run";
import { git } from "../engine/git";
import { type Budget, type LoopState, resumed } from "../engine/loop";
import { getSpace, type Space } from "../engine/spaces";
import { appendTaskDetail, getTask, setTaskBrief, setTaskLoop, setTaskStatus, type Task } from "../engine/tasks";
import { tierModel } from "../engine/tiers";
import { awaitingShape, chooseShape, proposeShape, type Shape, type ShapeKind, SHAPES, shapeChoices } from "../engine/shape";
import { childrenOf, discardFanout, FanoutRefused, mergeParts, partBody, pickAttempt } from "../engine/fanout";
import { openPullRequest } from "../engine/repos/pr";
import { recordUsage } from "../engine/usage";
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

// The shape a brief-first card is run with: the draft's proposal, checked again, and the kind the user left chosen,
// which is their click for a costlier one.
export async function cardShape(space: Space, brief: Brief, raw: unknown, kind: unknown, mixVendors: unknown): Promise<Shape | null> {
  if (space.kind !== "repo" || raw === undefined) return null;
  const ctx = { size: brief.size, checksFound: (await spaceChecks(space)).length > 0 };
  const proposed = proposeShape(raw, ctx);
  if (kind === undefined) return awaitingShape(proposed) ? { ...proposed, kind: "single", reason: "your choice" } : proposed;
  if (!SHAPES.includes(kind as ShapeKind)) throw new HttpError(400, "shape must be single, scouts, split or best_of_n.");
  try {
    return chooseShape(proposed, kind as ShapeKind, ctx, brief.goal, { mixVendors: mixVendors === true });
  } catch (e) {
    throw new HttpError(409, (e as Error).message);
  }
}

// Whether a task's shape can still change: nothing has run past its brief, and it hasn't fanned out.
const shapeOpen = (t: Task): boolean =>
  t.kind === "work" && t.status === "queued" && !!t.loop && !t.loop.fanout && !t.loop.role && (t.loop.stage === "brief" || (t.loop.stage === "writing" && t.loop.checkedSha == null && t.loop.said == null && t.loop.session == null));

// The user's choice of shape, checked against the task as it is now.
export async function shapeFor(db: Database, task: Task, kind: unknown, mixVendors: unknown): Promise<Shape> {
  if (!SHAPES.includes(kind as ShapeKind)) throw new HttpError(400, "kind must be single, scouts, split or best_of_n.");
  const space = getSpace(db, task.spaceId);
  if (!space) throw new HttpError(404, "No such space.");
  const ctx = { size: task.brief?.size ?? "medium", checksFound: (await spaceChecks(space)).length > 0 };
  try {
    return chooseShape(task.loop!.shape!, kind as ShapeKind, ctx, task.brief?.goal ?? task.title, { mixVendors: mixVendors === true });
  } catch (e) {
    throw new HttpError(409, (e as Error).message);
  }
}

// Each part's pull request, pushed only at its commit the user saw (`shas`, by task). A part that already has one is
// skipped, so a retry after a failure opens only the rest. Once all are open the parent is done.
async function openPartPrs(db: Database, parent: Task, space: Space, shas: unknown): Promise<{ opened: { taskId: string; url: string }[]; failed: { taskId: string; error: string }[] }> {
  if (parent.loop?.fanout?.kind !== "split" || parent.loop.stage !== "pick" || parent.status !== "queued") throw new FanoutRefused("This task has no parts waiting for you.");
  const seen = (shas && typeof shas === "object" ? shas : {}) as Record<string, unknown>;
  const opened: { taskId: string; url: string }[] = [];
  const failed: { taskId: string; error: string }[] = [];
  for (const part of childrenOf(db, parent)) {
    if (part.prUrl) continue;
    const sha = seen[part.id];
    if (typeof sha !== "string") {
      failed.push({ taskId: part.id, error: "Atrium didn't get the commit you saw for this part, so it wasn't pushed." });
      continue;
    }
    try {
      opened.push({ taskId: part.id, ...(await openPullRequest(db, part.id, { title: part.title, body: partBody(part, parent, space), sha })) });
    } catch (e) {
      failed.push({ taskId: part.id, error: (e as Error).message });
    }
  }
  if (!failed.length) {
    setTaskLoop(db, parent.id, { ...parent.loop, stage: "ready" });
    setTaskStatus(db, parent.id, "done");
  }
  return { opened, failed };
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
    recordUsage(db, { taskId: null, spaceId: space.id, agent: "claude", purpose: "brief", models: draft.models });
    const { models: _, shape: raw, ...reply } = draft;
    const ctx = { size: draft.brief.size, checksFound: checks.length > 0 };
    const shape = repo ? proposeShape(raw, ctx) : null;
    return json({ ...reply, shape, choices: shape ? shapeChoices(shape, ctx) : [], checks, hints: gapHints(draft.brief, { repo: space.kind === "repo", checksFound: checks.length > 0 }) });
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

  // The answers to a brief's questions and the shape to run go together, and the work starts. Sending no answers skips
  // them; sending no shape when a costlier one waits runs one writer, never the costlier shape.
  const answersM = method === "POST" ? pathname.match(/^\/api\/tasks\/([^/]+)\/answers$/) : null;
  if (answersM) {
    const task = getTask(db, answersM[1]!);
    const waiting = task?.loop && (task.loop.questions.length > 0 || awaitingShape(task.loop.shape));
    if (!task?.brief || !task.loop || !waiting || task.status !== "queued" || task.loop.stage !== "brief") throw new HttpError(409, "This task has nothing waiting for you before it starts.");
    const b = await readBody(req);
    const answers = normalizeBrief({ answers: b.answers }).answers.filter((a) => task.loop!.questions.some((q) => q.question === a.question));
    const kind = b.shape ?? (awaitingShape(task.loop.shape) ? "single" : undefined);
    const shape = task.loop.shape && kind !== undefined ? await shapeFor(db, task, kind, b.mixVendors) : task.loop.shape;
    setTaskBrief(db, task.id, { ...task.brief, answers: task.loop.questions.length ? answers : task.brief.answers });
    const next = setTaskLoop(db, task.id, { ...task.loop, questions: [], shape, stage: "writing" });
    kick();
    return json(next);
  }

  // The override on the task header: a different shape, any time before the writer starts.
  const shapeM = method === "POST" ? pathname.match(/^\/api\/tasks\/([^/]+)\/shape$/) : null;
  if (shapeM) {
    const task = getTask(db, shapeM[1]!);
    if (!task?.loop?.shape) throw new HttpError(404, "No such task with a shape.");
    if (!shapeOpen(task)) throw new HttpError(409, "This task has already started, so its shape can't change.");
    const b = await readBody(req);
    const shape = await shapeFor(db, task, b.kind, b.mixVendors);
    // Choosing answers the shape question; any questions of the brief still wait.
    const next = setTaskLoop(db, task.id, { ...task.loop, shape, stage: task.loop.questions.length ? "brief" : "writing" });
    kick();
    return json(next);
  }

  // A split's parts are ready: open each one's pull request (the click is the yes to push them), merge them into one
  // branch, or set them aside.
  const partsM = method === "POST" ? pathname.match(/^\/api\/tasks\/([^/]+)\/parts$/) : null;
  if (partsM) {
    const task = getTask(db, partsM[1]!);
    const space = task ? getSpace(db, task.spaceId) : null;
    if (!task || space?.kind !== "repo" || !space.repoPath) throw new HttpError(404, "No such task in a repo space.");
    const b = await readBody(req);
    try {
      if (b.action === "merge") await mergeParts(db, task.id, space);
      else if (b.action === "discard") discardFanout(db, task.id);
      else if (b.action === "prs") return json(await openPartPrs(db, task, space, b.shas));
      else throw new HttpError(400, "action must be merge, prs or discard.");
    } catch (e) {
      if (e instanceof FanoutRefused) throw new HttpError(409, e.message);
      throw e;
    }
    kick();
    return json(getTask(db, task.id));
  }

  // The user's pick among a best-of-N's attempts, or none of them.
  const pickM = method === "POST" ? pathname.match(/^\/api\/tasks\/([^/]+)\/pick$/) : null;
  if (pickM) {
    const task = getTask(db, pickM[1]!);
    const space = task ? getSpace(db, task.spaceId) : null;
    if (!task || space?.kind !== "repo" || !space.repoPath) throw new HttpError(404, "No such task in a repo space.");
    const b = await readBody(req);
    try {
      if (b.attempt === null) discardFanout(db, task.id);
      else await pickAttempt(db, task.id, str(b.attempt, "attempt"), space);
    } catch (e) {
      if (e instanceof FanoutRefused) throw new HttpError(409, e.message);
      throw e;
    }
    kick();
    return json(getTask(db, task.id));
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
