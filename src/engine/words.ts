// The words every surface uses for where a task is and for what waits on you: Home, a space, Needs you, the terminal
// app and the Mac app's notifications all read them from here, so one item never tells two stories.
import { pausedForYou, type QueueKind } from "./needs";

// One word per state, each with one meaning. Paused: the loop stopped itself (a budget, a check failing the same way)
// and waits for a hint or an explanation. Stopped: it can't go on until it's retried (you stopped it, an agent was
// signed out, a part of a split stopped). Nothing says "blocked" or "stuck".
export type TaskWord = "queued" | "running" | "review" | "paused" | "stopped" | "failed" | "done";

export const TASK_WORD: Record<TaskWord, string> = {
  queued: "queued",
  running: "running",
  review: "ready for review",
  paused: "paused",
  stopped: "stopped",
  failed: "failed",
  done: "done",
};

export function taskWord(t: Parameters<typeof pausedForYou>[0]): TaskWord {
  if (t.status === "blocked") return pausedForYou(t) ? "paused" : "stopped";
  return t.status as TaskWord;
}

// What each thing waiting on you is, and the one next step it asks for. The label tags its row everywhere; the action
// names the primary button on its decision screen and, with "…", the row's way to that screen, so the same item
// always offers the same step under the same name.
export const KIND: Record<QueueKind, { label: string; action: string }> = {
  review: { label: "Review", action: "Approve" },
  approval: { label: "Sign-off", action: "Approve" },
  question: { label: "Question", action: "Answer" },
  pick: { label: "Pick", action: "Choose" },
  stuck: { label: "Stopped", action: "Decide" },
  paused: { label: "Paused", action: "Give it a hint" },
  suggestion: { label: "Suggestion", action: "Stop asking" },
  memory: { label: "CLAUDE.md", action: "Add it" },
  shape: { label: "Could split", action: "Split instead" },
};

// A state as a row's label: "Paused", "Ready for review"; sentences use TASK_WORD as it is.
export const taskLabel = (w: TaskWord): string => TASK_WORD[w][0]!.toUpperCase() + TASK_WORD[w].slice(1);

// A row's way to the item's screen in Needs you: its action, marked as leading somewhere rather than doing it.
export const goTo = (kind: QueueKind): string => `${KIND[kind].action}…`;
