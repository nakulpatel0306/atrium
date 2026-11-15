import { useSyncExternalStore } from "react";

// Short messages at the bottom of the page. A plain one is gone after a few seconds; one with an Undo stays as long as
// the engine lets the action be taken back, and several stay side by side, so approving two things quickly never
// loses the first one's Undo. `key` names what an Undo is about (a task), so it can be withdrawn when that changes.
export type Toast = { id: number; text: string; key?: string; undo?: () => Promise<{ ok: boolean; error?: string }> };

export const TOAST_MS = 8000;
// The engine's own window for taking an approval back (approvals.ts UNDO_MS).
export const UNDO_TOAST_MS = 60_000;
let toasts: Toast[] = [];
let next = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();
const notify = () => {
  for (const fn of [...listeners]) fn();
};

export function showToast(text: string, undo?: Toast["undo"], key?: string): void {
  const t: Toast = { id: next++, text, undo, key };
  // A plain message replaces the last plain one. An Undo toast is never pushed out: it stays its full minute, so every
  // approval keeps its way back however fast they come.
  toasts = undo ? [...toasts, t] : [...toasts.filter((x) => x.undo), t];
  timers.set(t.id, setTimeout(() => dismissToast(t.id), undo ? UNDO_TOAST_MS : TOAST_MS));
  notify();
}

// Takes back the newest approval that still can be, as its Undo button would; the queue's z key.
export async function undoLatest(): Promise<void> {
  const t = [...toasts].reverse().find((x) => x.undo);
  if (!t?.undo) return showToast("Nothing to take back right now.");
  const res = await t.undo();
  dismissToast(t.id);
  if (!res.ok) showToast(res.error ?? "Atrium couldn't take that back. Ask for the change again as a new task.");
}

// One toast by id; with none, every toast.
export function dismissToast(id?: number): void {
  for (const t of toasts) {
    if (id !== undefined && t.id !== id) continue;
    clearTimeout(timers.get(t.id));
    timers.delete(t.id);
  }
  toasts = id === undefined ? [] : toasts.filter((t) => t.id !== id);
  notify();
}

// Withdraws the Undo for something that has since moved on (a push started for that task).
export function withdrawUndo(key: string): void {
  for (const t of toasts) if (t.key === key && t.undo) dismissToast(t.id);
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => toasts,
    () => toasts,
  );
}
