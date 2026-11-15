// What counts as needing the user, in one place for every app: the dashboard's Needs you queue, the terminal app,
// the Mac app's badge and `atrium status`. Imports nothing but types, so the dashboard can bundle it.
import type { LoopState } from "./loop";

type TaskLike = { id: string; kind: string; status: string; spaceId: string; parentTaskId: string | null; loop: LoopState | null };
type InSpace = { spaceId: string | null };

// A split or best-of-N still waiting on its children while one of them stopped: that child needs a hint or a retry,
// or the whole fan-out needs setting aside, so the parent asks too. `tasks` holds its children.
const waitsOnStuckChild = (t: TaskLike, tasks: readonly TaskLike[]): boolean =>
  t.loop?.stage === "parts" && tasks.some((c) => c.parentTaskId === t.id && c.kind === "work" && c.loop?.role === "part" && (c.status === "blocked" || c.status === "failed"));

// A task waiting on the user before anything more runs: its brief's questions, a split's parts or best-of-N's
// attempts ready for a decision, or a split with a part that stopped. A shape the pre-pass suggests never waits:
// the task runs as one writer meanwhile.
export const asksBeforeStarting = (t: TaskLike, tasks: readonly TaskLike[] = []): boolean =>
  t.kind === "work" && t.status === "queued" && ((t.loop?.questions.length ?? 0) > 0 || t.loop?.stage === "pick" || waitsOnStuckChild(t, tasks));

// Atrium paused it (a budget ran out, or it looked stuck) and it waits for a hint or an explanation. A paused part
// is left to its parent, which asks for the whole split.
export const pausedForYou = (t: TaskLike): boolean => t.kind === "work" && t.status === "blocked" && t.loop?.paused != null && !t.loop.role;

// The pre-pass suggested a costlier shape while the task runs as one writer; worth a look, never a wait.
export const suggestsShape = (t: TaskLike): boolean => {
  const shape = t.loop?.shape;
  return t.kind === "work" && t.status === "running" && !t.loop?.role && !!shape && shape.kind === "single" && (shape.proposed === "split" || shape.proposed === "best_of_n") && shape.approved !== true;
};

// review: a result to approve or send back; approval: any other question; question: a brief's questions; pick: a
// split's parts or best-of-N's attempts to decide on; stuck: a split with a part that stopped; paused: a budget or
// loop pause; suggestion: "stop asking about this?"; memory: a proposed CLAUDE.md line; shape: a suggested split
// or best-of-N on a running task.
export type QueueKind = "review" | "approval" | "question" | "pick" | "stuck" | "paused" | "suggestion" | "memory" | "shape";

// `key` is the id that answers it (the approval, proposal or memory line, else the task). `since` is when it started
// waiting. A `low` item is listed after everything else and never counted: nothing is held up on it.
export type QueueItem = { key: string; kind: QueueKind; spaceId: string | null; taskId: string | null; since: number; low: boolean };

export type QueueInput = {
  spaces: readonly { id: string }[];
  approvals: readonly (InSpace & { id: string; taskId: string | null; kind: string; alwaysAsk: string | null; createdAt: number })[];
  proposals: readonly (InSpace & { id: string; createdAt: number })[];
  tasks: readonly (TaskLike & { outcome: string | null; updatedAt: number })[];
  // Open CLAUDE.md proposals, as the state carries them; missing from an engine that predates the queue.
  learning?: { memory: readonly { id: string; spaceId: string; taskId: string | null; createdAt: number }[] };
};

// Everything waiting on the user in active spaces, longest-blocked first; ties go by space, in the order the spaces
// are listed. An Atrium-wide question belongs to no space and always counts.
export function attentionQueue(s: QueueInput): QueueItem[] {
  const order = new Map(s.spaces.map((x, i) => [x.id, i]));
  const active = (spaceId: string | null) => spaceId === null || order.has(spaceId);
  const items: QueueItem[] = [];
  for (const a of s.approvals) {
    if (active(a.spaceId)) items.push({ key: a.id, kind: a.kind === "review" ? "review" : "approval", spaceId: a.spaceId, taskId: a.taskId, since: a.createdAt, low: false });
  }
  for (const p of s.proposals) if (active(p.spaceId)) items.push({ key: p.id, kind: "suggestion", spaceId: p.spaceId, taskId: null, since: p.createdAt, low: false });
  for (const t of s.tasks) {
    if (!order.has(t.spaceId)) continue;
    const kind: QueueKind | null = asksBeforeStarting(t, s.tasks)
      ? t.loop?.questions.length ? "question" : t.loop?.stage === "pick" ? "pick" : "stuck"
      : pausedForYou(t) ? "paused" : suggestsShape(t) ? "shape" : null;
    if (kind) items.push({ key: t.id, kind, spaceId: t.spaceId, taskId: t.id, since: t.updatedAt, low: kind === "shape" });
  }
  for (const m of s.learning?.memory ?? []) if (order.has(m.spaceId)) items.push({ key: m.id, kind: "memory", spaceId: m.spaceId, taskId: m.taskId, since: m.createdAt, low: true });
  const rank = (i: QueueItem) => (i.spaceId === null ? -1 : order.get(i.spaceId)!);
  // Stable, so items of one space that started waiting in the same millisecond keep the order they were listed in.
  return items.sort((a, b) => Number(a.low) - Number(b.low) || a.since - b.since || rank(a) - rank(b));
}

export const needsYouCount = (s: QueueInput): number => attentionQueue(s).filter((i) => !i.low).length;

// The one rule for a clean result, with nothing to read first: the agent finished and changed something, the checks
// passed (not unverified, nothing already failing), the change left no attention note, the last review approved it,
// and no medium or high finding from any round is left unfixed. A low note on an approval doesn't block: the writer
// is never asked to answer those. The row's tone, "Approve anyway", the two-press key and batch approval all use this,
// so they can't disagree.
export function cleanResult(t: { outcome: string | null; loop: LoopState | null } | undefined): boolean {
  const loop = t?.loop;
  if (t?.outcome !== "done" || !loop) return false;
  if (loop.noChanges || loop.checks !== "passed" || loop.unverified || loop.attention.length > 0 || loop.alreadyFailing.length > 0) return false;
  const last = loop.reviews.at(-1);
  if (!last || last.skipped || last.verdict !== "approve") return false;
  return loop.reviews.every((r) => !r.skipped && r.findings.every((f) => f.severity === "low" || f.resolution?.action === "fixed"));
}

// Whether a result may be approved together with others in one go: a clean review result that only the user's own
// rules could decide. The engine checks this again, against the commit, before it approves.
export const batchApprovable = (a: { kind: string; alwaysAsk: string | null }, t: { outcome: string | null; loop: LoopState | null } | undefined): boolean =>
  a.kind === "review" && !a.alwaysAsk && cleanResult(t);

// What such a task asks, in one line: its first question, the decision on its parts or attempts, the part that
// stopped, or its pause.
export function askLine(t: TaskLike): string {
  const loop = t.loop;
  if (loop?.questions.length) return loop.questions[0]!.question;
  if (loop?.stage === "pick") return loop.fanout?.kind === "best_of_n" ? "pick one of its attempts" : "its parts are ready to open or merge";
  if (loop?.stage === "parts") return "one of its parts stopped: give it a hint, retry it, or set the parts aside";
  if (loop?.paused) return loop.paused.diagnosis;
  return "it's waiting for you";
}
