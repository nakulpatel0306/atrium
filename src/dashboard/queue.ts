// The attention queue as the dashboard shows it: each item's title and one-line summary, from the one definition
// in engine/needs.ts. The terminal app reads the same lines, so both say the same thing.
import { askLine, attentionQueue, batchApprovable, cleanResult, type QueueItem, type QueueKind } from "../engine/needs";
import type { State } from "../engine/state";
import { CLEAN, KIND, RISKY, taskLabel, taskWord } from "../engine/words";
import { reviewChips, summaryLine } from "./summary";
import { clock } from "./format";

export type { QueueItem, QueueKind };
export { attentionQueue };

// What kind of decision each item is, as its row's label: the shared words (engine/words.ts).
export const KIND_TEXT = Object.fromEntries(Object.entries(KIND).map(([k, v]) => [k, v.label])) as Record<QueueKind, string>;

const approvalOf = (state: State, i: QueueItem) => state.approvals.find((a) => a.id === i.key);
const taskOf = (state: State, i: QueueItem) => (i.taskId ? state.tasks.find((t) => t.id === i.taskId) : undefined);

export function itemTitle(state: State, i: QueueItem): string {
  if (i.kind === "review" || i.kind === "approval") return approvalOf(state, i)?.title ?? "";
  if (i.kind === "suggestion") return `Stop asking about ${state.proposals.find((p) => p.id === i.key)?.label ?? "this"}?`;
  if (i.kind === "memory") return "Add a line to CLAUDE.md?";
  if (i.kind === "starting") return state.held.find((h) => h.id === i.key)?.title ?? "";
  return taskOf(state, i)?.title ?? "";
}

// The one line under the title: what the checks and reviewer said, what it asks, or why it stopped.
export function itemLine(state: State, i: QueueItem): string {
  if (i.kind === "review" || i.kind === "approval") {
    const a = approvalOf(state, i);
    if (!a) return "";
    // The reviewer's half leads, so a narrow row cuts the checks (green or red at a glance elsewhere), never "1 open
    // finding".
    const chips = reviewChips(a, state);
    return chips ? [chips.review?.text, chips.checks.text].filter(Boolean).join(" · ") : summaryLine(a.detail);
  }
  if (i.kind === "suggestion") {
    const p = state.proposals.find((x) => x.id === i.key);
    return p ? `You approved the last ${p.evidence.length} without changes.` : "";
  }
  if (i.kind === "memory") return state.learning.memory.find((m) => m.id === i.key)?.line ?? "";
  if (i.kind === "starting") {
    const h = state.held.find((x) => x.id === i.key);
    return h ? `You said yes. It starts at ${clock(h.startsAt)} unless you take it back.` : "";
  }
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

// A result's one word wherever it's listed (the queue, Home, its space): Needs a look or Clean, by the one rule
// (needs.ts). Null for anything that didn't go through the loop, which keeps its kind's label.
export function resultWord(state: State, a: State["approvals"][number]): string | null {
  if (!reviewChips(a, state)) return null;
  return isRisky(state, a) ? RISKY : CLEAN;
}

// A task in review's verdict, for lists that name tasks by state (the terminal app's), else null.
export function taskVerdict(state: State, t: State["tasks"][number]): string | null {
  const a = t.status === "review" ? state.approvals.find((x) => x.taskId === t.id && x.kind === "review" && x.status === "pending") : undefined;
  return a ? resultWord(state, a) : null;
}

// A task's one word in a list that names tasks (the palette): what it waits on you for when that isn't its state (a
// question, a pick, a stopped part), a result's verdict, else its state word.
export function taskTag(state: State, t: State["tasks"][number]): string {
  const item = attentionQueue(state).find((i) => i.key === t.id);
  if (item && (item.kind === "question" || item.kind === "pick" || item.kind === "stuck")) return KIND[item.kind].label;
  const a = t.status === "review" ? state.approvals.find((x) => x.taskId === t.id && x.kind === "review" && x.status === "pending") : undefined;
  return (a && resultWord(state, a)) ?? taskLabel(taskWord(t));
}

// The label a queue item wears: a result's verdict, else its kind.
export function itemLabel(state: State, i: QueueItem): string {
  const a = i.kind === "review" ? approvalOf(state, i) : undefined;
  return (a && resultWord(state, a)) ?? KIND_TEXT[i.kind];
}

// The commit a result's screen shows: the one its checks and review read. Approving sends it, so the approval binds to
// what the user looked at.
export function shownSha(state: State, a: State["approvals"][number]): string | null {
  const task = a.taskId ? state.tasks.find((t) => t.id === a.taskId) : undefined;
  return task?.branch ? (task.loop?.checkedSha ?? null) : null;
}
