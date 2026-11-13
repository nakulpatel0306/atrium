// What counts as needing the user, in one place for every app: the dashboard's Needs you, the terminal app, the
// Mac app's badge and `atrium status`. Imports nothing but types, so the dashboard can bundle it.
import type { LoopState } from "./loop";


type TaskLike = { kind: string; status: string; spaceId: string; loop: LoopState | null };
type InSpace = { spaceId: string | null };

// A task waiting on the user before anything more runs: its brief's questions, or a split's parts or best-of-N's
// attempts ready for a decision. A shape the pre-pass suggests never waits: the task runs as one writer meanwhile.
export const asksBeforeStarting = (t: TaskLike): boolean =>
  t.kind === "work" && t.status === "queued" && ((t.loop?.questions.length ?? 0) > 0 || t.loop?.stage === "pick");

// Approvals and questions waiting on the user, rule suggestions, and tasks asking before they start, in active
// spaces only (`spaces` lists those); an Atrium-wide question belongs to no space and always counts.
export function needsYouCount(s: { spaces: readonly { id: string }[]; approvals: readonly InSpace[]; proposals: readonly InSpace[]; tasks: readonly TaskLike[] }): number {
  const active = new Set(s.spaces.map((x) => x.id));
  const counts = (x: InSpace) => x.spaceId === null || active.has(x.spaceId);
  return s.approvals.filter(counts).length + s.proposals.filter(counts).length + s.tasks.filter((t) => asksBeforeStarting(t) && active.has(t.spaceId)).length;
}

// What such a task asks, in one line: its first question, the shape waiting for a yes, or the decision on its parts.
export function askLine(t: TaskLike): string {
  const loop = t.loop;
  if (loop?.questions.length) return loop.questions[0]!.question;
  if (loop?.stage === "pick") return loop.fanout?.kind === "best_of_n" ? "pick one of its attempts" : "its parts are ready to open or merge";
  return "it's waiting for you";
}
