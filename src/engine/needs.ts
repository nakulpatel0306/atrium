// What counts as needing the user, in one place for every app: the dashboard's Needs you, the terminal app, the
// Mac app's badge and `atrium status`. Imports nothing but types, so the dashboard can bundle it.
import type { LoopState } from "./loop";

type TaskLike = { kind: string; status: string; spaceId: string; loop: LoopState | null };
type InSpace = { spaceId: string | null };

// A task whose brief asked something before the writer starts, waiting for the answers.
export const asksBeforeStarting = (t: TaskLike): boolean => t.kind === "work" && t.status === "queued" && (t.loop?.questions.length ?? 0) > 0;

// Approvals and questions waiting on the user, rule suggestions, and tasks asking before they start, in active
// spaces only (`spaces` lists those); an Atrium-wide question belongs to no space and always counts.
export function needsYouCount(s: { spaces: readonly { id: string }[]; approvals: readonly InSpace[]; proposals: readonly InSpace[]; tasks: readonly TaskLike[] }): number {
  const active = new Set(s.spaces.map((x) => x.id));
  const counts = (x: InSpace) => x.spaceId === null || active.has(x.spaceId);
  return s.approvals.filter(counts).length + s.proposals.filter(counts).length + s.tasks.filter((t) => asksBeforeStarting(t) && active.has(t.spaceId)).length;
}
