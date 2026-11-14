// What counts as needing the user, in one place for every app: the dashboard's Needs you, the terminal app, the
// Mac app's badge and `atrium status`. Imports nothing but types, so the dashboard can bundle it.
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

// Approvals and questions waiting on the user, rule suggestions, and tasks asking before they start, in active
// spaces only (`spaces` lists those); an Atrium-wide question belongs to no space and always counts.
export function needsYouCount(s: { spaces: readonly { id: string }[]; approvals: readonly InSpace[]; proposals: readonly InSpace[]; tasks: readonly TaskLike[] }): number {
  const active = new Set(s.spaces.map((x) => x.id));
  const counts = (x: InSpace) => x.spaceId === null || active.has(x.spaceId);
  return s.approvals.filter(counts).length + s.proposals.filter(counts).length + s.tasks.filter((t) => asksBeforeStarting(t, s.tasks) && active.has(t.spaceId)).length;
}

// What such a task asks, in one line: its first question, the decision on its parts or attempts, or the part that
// stopped.
export function askLine(t: TaskLike): string {
  const loop = t.loop;
  if (loop?.questions.length) return loop.questions[0]!.question;
  if (loop?.stage === "pick") return loop.fanout?.kind === "best_of_n" ? "pick one of its attempts" : "its parts are ready to open or merge";
  if (loop?.stage === "parts") return "one of its parts stopped: give it a hint, retry it, or set the parts aside";
  return "it's waiting for you";
}
