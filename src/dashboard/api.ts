import { useSyncExternalStore } from "react";
import type { State } from "../engine/state";

export type { State };

type EngineMessage = { type: "changed" } | { type: "run-output"; runId: string; taskId: string; chunk: string };

// Live output is only for watching; the full record is the transcript, so keep just the tail.
const OUTPUT_TAIL = 200_000;

let state: State | null = null;
let online = true;
let started = false;
let fetching = false;
let refetch = false;
const outputs = new Map<string, string>();
const listeners = new Set<() => void>();

const notify = () => {
  for (const fn of [...listeners]) fn();
};

async function refresh(): Promise<void> {
  // A burst of `changed` events collapses into one follow-up fetch.
  if (fetching) {
    refetch = true;
    return;
  }
  fetching = true;
  try {
    const res = await fetch("/api/state");
    if (res.ok) {
      state = (await res.json()) as State;
      notify();
    }
  } catch {
    // The socket's close handler shows the reconnecting state and refetches on reconnect.
  } finally {
    fetching = false;
    if (refetch) {
      refetch = false;
      void refresh();
    }
  }
}

function connect(): void {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => {
    online = true;
    notify();
    void refresh();
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as EngineMessage;
    if (msg.type === "changed") {
      void refresh();
    } else if (msg.type === "run-output") {
      outputs.set(msg.runId, ((outputs.get(msg.runId) ?? "") + msg.chunk).slice(-OUTPUT_TAIL));
      notify();
    }
  };
  ws.onclose = () => {
    if (online) {
      online = false;
      notify();
    }
    setTimeout(connect, 2000);
  };
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  if (!started) {
    started = true;
    connect();
  }
  return () => listeners.delete(fn);
}

export function useEngineState(): State | null {
  return useSyncExternalStore(subscribe, () => state);
}

export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, () => online);
}

export function useRunOutput(runId: string): string {
  return useSyncExternalStore(subscribe, () => outputs.get(runId) ?? "");
}

export type PostResult<T> = { ok: true; data: T } | { ok: false; error: string };

export async function post<T = unknown>(path: string, body?: unknown): Promise<PostResult<T>> {
  try {
    const res = await fetch(path, {
      method: "POST",
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res.ok) return { ok: false, error: data?.error ?? `Atrium answered with an error (${res.status}). Try again.` };
    return { ok: true, data: data as T };
  } catch {
    return { ok: false, error: "Can't reach the Atrium engine. Check that it's running, then try again." };
  }
}
