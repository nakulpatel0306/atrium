// What counts as needing the user, in one place for every app: the dashboard's Needs you, the terminal app, the
// Mac app's badge and `atrium status`. Imports nothing but types, so the dashboard can bundle it.
import type { LoopState } from "./loop";

type TaskLike = { kind: string; status: string; loop: LoopState | null };

// A task whose brief asked something before the writer starts, waiting for the answers.
export const asksBeforeStarting = (t: TaskLike): boolean => t.kind === "work" && t.status === "queued" && (t.loop?.questions.length ?? 0) > 0;

// Approvals and questions waiting on the user, rule suggestions, and tasks asking before they start.
export function needsYouCount(s: { approvals: readonly unknown[]; proposals: readonly unknown[]; tasks: readonly TaskLike[] }): number {
  return s.approvals.length + s.proposals.length + s.tasks.filter(asksBeforeStarting).length;
}
