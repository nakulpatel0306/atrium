// The attention queue as the dashboard shows it: each item's title and one-line summary, from the one definition
// in engine/needs.ts. The terminal app reads the same lines, so both say the same thing.
import { askLine, attentionQueue, batchApprovable, cleanResult, type QueueItem, type QueueKind } from "../engine/needs";
import type { State } from "../engine/state";
import { reviewLine, summaryLine } from "./summary";

export type { QueueItem, QueueKind };
export { attentionQueue };

// What kind of decision each item is, as its row's label.
export const KIND_TEXT: Record<QueueKind, string> = {
  review: "Review",
  approval: "Question",
  question: "Question",
  pick: "Choose",
  stuck: "Part stopped",
  paused: "Paused",
  suggestion: "Suggestion",
  memory: "CLAUDE.md",
  shape: "Could split",
};

const approvalOf = (state: State, i: QueueItem) => state.approvals.find((a) => a.id === i.key);
const taskOf = (state: State, i: QueueItem) => (i.taskId ? state.tasks.find((t) => t.id === i.taskId) : undefined);

export function itemTitle(state: State, i: QueueItem): string {
  if (i.kind === "review" || i.kind === "approval") return approvalOf(state, i)?.title ?? "";
  if (i.kind === "suggestion") return `Stop asking about ${state.proposals.find((p) => p.id === i.key)?.label ?? "this"}?`;
  if (i.kind === "memory") return "Add a line to CLAUDE.md?";
  return taskOf(state, i)?.title ?? "";
}

// The one line under the title: what the checks and reviewer said, what it asks, or why it stopped.
export function itemLine(state: State, i: QueueItem): string {
  if (i.kind === "review" || i.kind === "approval") {
    const a = approvalOf(state, i);
    if (!a) return "";
    return reviewLine(a, state)?.text ?? summaryLine(a.detail);
  }
  if (i.kind === "suggestion") {
    const p = state.proposals.find((x) => x.id === i.key);
    return p ? `You approved the last ${p.evidence.length} without changes.` : "";
  }
  if (i.kind === "memory") return state.learning.memory.find((m) => m.id === i.key)?.line ?? "";
  const t = taskOf(state, i);
  if (!t) return "";
  if (i.kind === "shape") return t.loop?.shape?.reason ?? "";
  return askLine(t);
}

// Results that may be approved together: each one finished with passing checks, no attention note, nothing
// unverified and every review finding fixed. The engine checks each again before it approves.
export function cleanReviews(state: State, items: QueueItem[] = attentionQueue(state)): QueueItem[] {
  return items.filter((i) => {
    const a = i.kind === "review" ? approvalOf(state, i) : undefined;
    return !!a && batchApprovable(a, taskOf(state, i));
  });
}

// How long it has waited, in a few characters: "4m", "2h", "3d".
export function waited(since: number, now = Date.now()): string {
  const m = Math.max(0, Math.floor((now - since) / 60_000));
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// A result that went through the loop but isn't clean by the one rule (needs.ts), including one the agent didn't say
// it finished: its Approve is quieter and the a key asks twice.
export function isRisky(state: State, a: State["approvals"][number]): boolean {
  const task = a.kind === "review" && a.taskId ? state.tasks.find((t) => t.id === a.taskId) : undefined;
  return !!task?.loop && !cleanResult(task);
}

// The commit a result's screen shows: the one its checks and review read. Approving sends it, so the approval binds to
// what the user looked at.
export function shownSha(state: State, a: State["approvals"][number]): string | null {
  const task = a.taskId ? state.tasks.find((t) => t.id === a.taskId) : undefined;
  return task?.branch ? (task.loop?.checkedSha ?? null) : null;
}
