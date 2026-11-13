// The Needs you page's keys. Single letters only move, open, approve a review or open its send-back note, and every
// key is ignored while Nakul is typing.
export type NeedsKey = "next" | "prev" | "open" | "approve" | "sendBack" | "close";

type KeyLike = { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; target: EventTarget | null };

const KEYS: Record<string, NeedsKey> = { j: "next", ArrowDown: "next", k: "prev", ArrowUp: "prev", Enter: "open", a: "approve", s: "sendBack", Escape: "close" };

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

// The control a key presses on the focused row; a row without it (a rule suggestion) ignores the key.
export const ACT: Partial<Record<NeedsKey, string>> = { open: "open", approve: "approve", sendBack: "send-back" };
