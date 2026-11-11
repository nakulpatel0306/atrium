import { useEffect, useRef, useSyncExternalStore } from "react";
import { post } from "./api";
import { announce } from "./live";

// A pressed Send waits this long before anything reaches Messages, so a slip can be taken back.
export const SEND_DELAY_MS = 5000;

// What the card sends, fixed at the press: a person's text has a handle and service, a group's a chat id.
export type SendBody = { text: string; handle?: string; service?: string; chatId?: string };

// One text waiting out its window, or already on its way once `sending` is set; by then it can't be undone.
export type PendingSend = { id: string; name: string; body: SendBody; startedAt: number; sending: boolean };

// Each text waits in its own entry, keyed by its message action, so one send can never take another's Undo away and
// a card that remounts reads the truth from here.
const pending = new Map<string, PendingSend & { timer: ReturnType<typeof setTimeout> }>();
const failed = new Map<string, string>();
let list: PendingSend[] = [];
const listeners = new Set<() => void>();

function changed(): void {
  list = [...pending.values()].map(({ timer: _, ...p }) => p);
  for (const fn of [...listeners]) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function fire(id: string): Promise<void> {
  const p = pending.get(id);
  if (!p) return;
  pending.set(id, { ...p, sending: true });
  changed();
  const res = await post(`/api/message-actions/${id}/send`, p.body);
  pending.delete(id);
  // On success the card leaves with the next state push; the space's history shows the send.
  if (res.ok) announce(`Sent to ${p.name}.`);
  else {
    failed.set(id, res.error);
    announce(`Didn't send to ${p.name}. ${res.error}`);
  }
  changed();
}

export function startSend(id: string, name: string, body: SendBody): void {
  if (pending.has(id)) return;
  failed.delete(id);
  pending.set(id, { id, name, body, startedAt: Date.now(), sending: false, timer: setTimeout(() => void fire(id), SEND_DELAY_MS) });
  announce(`Sending to ${name} in ${SEND_DELAY_MS / 1000} seconds. Undo is in the Sending list.`);
  changed();
}

// Takes a send back while it's still waiting. Returns whether it was stopped.
export function cancelSend(id: string, lead = "Not sent to"): boolean {
  const p = pending.get(id);
  if (!p || p.sending) return false;
  clearTimeout(p.timer);
  pending.delete(id);
  announce(`${lead} ${p.name}. It's still drafted.`);
  changed();
  return true;
}

// Leaving the page stops every waiting send: a text never goes out from a page Nakul can no longer see.
export function cancelAll(): void {
  for (const id of [...pending.keys()]) cancelSend(id, "Didn't send to");
}

export const pendingSendOf = (id: string): PendingSend | null => list.find((p) => p.id === id) ?? null;

export const usePendingSends = (): PendingSend[] => useSyncExternalStore(subscribe, () => list, () => list);

export const usePendingSend = (id: string): PendingSend | null => {
  const all = usePendingSends();
  return all.find((p) => p.id === id) ?? null;
};

// The last send's failure for a card, kept here so it survives the card remounting.
export const useSendError = (id: string): string | null => {
  usePendingSends();
  return failed.get(id) ?? null;
};

export const clearSendError = (id: string): void => {
  if (failed.delete(id)) changed();
};

// Cancels every waiting send when the path changes, but not on the first render.
export function useCancelOnRouteChange(path: string): void {
  const last = useRef(path);
  useEffect(() => {
    if (path === last.current) return;
    last.current = path;
    cancelAll();
  }, [path]);
}
