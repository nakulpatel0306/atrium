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
export const KIND: Record<QueueKind, { label: string; action: string; means: string }> = {
  review: { label: "Review", action: "Approve", means: "A finished result, checked and reviewed, waiting for your yes." },
  approval: { label: "Sign-off", action: "Approve", means: "Something Atrium will do on your behalf, like making a GitHub repo." },
  question: { label: "Question", action: "Answer", means: "A brief with a question before its work starts." },
  pick: { label: "Pick", action: "Choose", means: "Attempts or parts ready for you to choose between or open." },
  stuck: { label: "Stopped", action: "Decide", means: "A part of a split stopped: give it a hint, retry it, or set the parts aside." },
  paused: { label: "Paused", action: "Give it a hint", means: "The loop stopped itself (a budget, the same failure twice) and waits for a hint." },
  suggestion: { label: "Suggestion", action: "Stop asking", means: "A kind of result you always approve unchanged; a rule could approve it for you." },
  memory: { label: "CLAUDE.md", action: "Add it", means: "A line Atrium suggests for the repo's CLAUDE.md. Low priority." },
  shape: { label: "Could split", action: "Split instead", means: "A running task that could run as parts. Low priority." },
  starting: { label: "Starting", action: "Undo", means: "A yes to a new repo or a removal, held a minute before it starts; it can still be taken back." },
};

// A result waiting on you that isn't clean (needs.ts): one name wherever it shows, on its chip, its row, its step and
// the reasons above its diff.
export const RISKY = "Needs a look";
// Its opposite, on a summary row's one chip: checks passed, the reviewer approved, nothing left open.
export const CLEAN = "Clean";

// A state as a row's label: "Paused", "Ready for review"; sentences use TASK_WORD as it is.
export const taskLabel = (w: TaskWord): string => TASK_WORD[w][0]!.toUpperCase() + TASK_WORD[w].slice(1);

// A row's way to the item's screen in Needs you: its action, marked as leading somewhere rather than doing it.
export const goTo = (kind: QueueKind): string => `${KIND[kind].action}…`;
