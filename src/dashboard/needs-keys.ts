// The Needs you queue's keys. Single letters only move, open, and press a button the open item already shows, and
// every key is ignored while the user is typing.
export type NeedsKey = "next" | "prev" | "open" | "approve" | "sendBack" | "stop" | "explain" | "batch" | "undo" | "help" | "close";

type KeyLike = { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; target: EventTarget | null };

const KEYS: Record<string, NeedsKey> = {
  j: "next",
  ArrowDown: "next",
  k: "prev",
  ArrowUp: "prev",
  Enter: "open",
  a: "approve",
  s: "sendBack",
  x: "stop",
  e: "explain",
  A: "batch",
  z: "undo",
  "?": "help",
  Escape: "close",
};

export function isTyping(target: EventTarget | null): boolean {
  if (!target || typeof target !== "object" || !("tagName" in target)) return false;
  const el = target as { tagName: string; isContentEditable?: boolean };
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable === true;
}

export function needsKey(e: KeyLike): NeedsKey | null {
  if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return null;
  return KEYS[e.key] ?? null;
}

// Which row has focus after a move, clamped to the list rather than wrapping past its ends.
export function moveFocus(at: number, count: number, key: "next" | "prev"): number {
  if (count === 0) return -1;
  if (at < 0) return key === "next" ? 0 : count - 1;
  return Math.max(0, Math.min(count - 1, at + (key === "next" ? 1 : -1)));
}

// The control a key presses in the open item; an item without it (a rule suggestion has no stop) ignores the key.
export const ACT: Partial<Record<NeedsKey, string>> = { approve: "approve", sendBack: "send-back", stop: "stop", explain: "explain" };

// The keys as the help sheet lists them.
export const KEY_HELP: [string, string][] = [
  ["j / k", "Next / previous item"],
  ["Enter", "Open the item"],
  ["a", "Approve; twice on a result that Needs a look"],
  ["s", "Send back with a note"],
  ["x", "Stop a running task"],
  ["e", "Explain the problem, on a paused task"],
  ["Shift A", "Approve every clean result at once"],
  ["z", "Take back the last approval, within its minute"],
  ["Esc", "Back to the list"],
  ["?", "Show or hide these keys"],
];

// The keys on a space's page, which act on the task opened in it: only the ones that press a decision's buttons.
export const PAGE_KEY_HELP: [string, string][] = [
  ["a", "Approve the open result; twice on one that Needs a look"],
  ["s", "Send the open result back with a note"],
  ["x", "Stop the open task while it runs"],
  ["e", "Explain the problem, on an open paused task"],
  ["z", "Take back the last approval, within its minute"],
  ["Esc", "Cancel a first a, or hide these keys"],
  ["?", "Show or hide these keys"],
];

export const PAGE_KEY_NOTE = "They act on the task you've opened. With more than one open, click in the one you mean first.";

// What a page key says when no open task shows its button.
export const NOTHING_FOR: Partial<Record<NeedsKey, string>> = {
  approve: "Nothing open here to approve. Open a task that's ready for review.",
  sendBack: "Nothing open here to send back. Open a task that's ready for review.",
  stop: "No open task is running.",
  explain: "Explain is for a paused task. Open one first.",
};
