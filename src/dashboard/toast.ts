import { useSyncExternalStore } from "react";

// One short message at the bottom of the page, optionally with an Undo, gone after a few seconds.
export type Toast = { id: number; text: string; undo?: () => Promise<{ ok: boolean; error?: string }> };

export const TOAST_MS = 8000;

let current: Toast | null = null;
let next = 1;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
const notify = () => {
  for (const fn of [...listeners]) fn();
};

export function showToast(text: string, undo?: Toast["undo"]): void {
  if (timer) clearTimeout(timer);
  current = { id: next++, text, undo };
  const id = current.id;
  timer = setTimeout(() => current?.id === id && dismissToast(), TOAST_MS);
  notify();
}

export function dismissToast(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  current = null;
  notify();
}

export function useToast(): Toast | null {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => current,
    () => current,
  );
}
