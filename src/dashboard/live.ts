import { useSyncExternalStore } from "react";

// What the screen reader should say after something happens off to the side: a text sent, a result approved.
export type Announcement = { id: number; text: string };

let current: Announcement | null = null;
let next = 1;
const listeners = new Set<() => void>();

export function announce(text: string): void {
  current = { id: next++, text };
  for (const fn of [...listeners]) fn();
}

export function useAnnouncement(): Announcement | null {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => current,
    () => current,
  );
}
