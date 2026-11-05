import { useEffect, useState, useSyncExternalStore } from "react";
import type { Approval } from "../engine/approvals";
import type { Proposal } from "../engine/autonomy/proposals";
import type { Rule, RuleEventRow } from "../engine/autonomy/rules";
import type { Message } from "../engine/messages";
import type { State } from "../engine/state";

export type { Message, State };
export type RuleDetail = { rule: Rule; proposal: Proposal | null; approvals: Approval[]; events: RuleEventRow[] };

export { activeOnly } from "./summary";

type EngineMessage = { type: "changed" } | { type: "run-output"; runId: string; taskId: string; chunk: string };

// Live output is only for watching; the full record is the transcript, so keep just the tail.
const OUTPUT_TAIL = 200_000;

let state: State | null = null;
let online = true;
let started = false;
let fetching = false;
let refetch = false;
const outputs = new Map<string, string>();
const seeded = new Set<string>();
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
      // Chunks are whole lines without their newline, the same as the transcript stores them.
      outputs.set(msg.runId, `${outputs.get(msg.runId) ?? ""}${msg.chunk}\n`.slice(-OUTPUT_TAIL));
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

// A run that started before this page opened has output only in its transcript, so start from that.
async function seedOutput(runId: string): Promise<void> {
  seeded.add(runId);
  const res = await fetchTranscript(runId);
  if (!res.ok) return;
  // Chunks that arrived during the fetch were written to the transcript before they were sent.
  outputs.set(runId, res.text.slice(-OUTPUT_TAIL));
  notify();
}

export function useRunOutput(runId: string): string {
  useEffect(() => {
    if (!seeded.has(runId)) void seedOutput(runId);
  }, [runId]);
  return useSyncExternalStore(subscribe, () => outputs.get(runId) ?? "");
}

// Reads data that isn't part of the pushed state, again whenever `version` changes.
function useFetched<T>(path: string | null, version: unknown): T | null {
  const [data, setData] = useState<{ path: string; value: T } | null>(null);
  useEffect(() => {
    if (!path) return;
    let live = true;
    fetch(path)
      .then((res) => (res.ok ? (res.json() as Promise<T>) : null))
      .then((value) => live && value !== null && setData({ path, value }))
      // A failed read keeps what's shown; the next change tries again.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [path, version]);
  return data && data.path === path ? data.value : null;
}

// A thread grows as agents hand work back and forth, which any state push can mean.
export const useMessages = (taskId: string | null) =>
  useFetched<Message[]>(taskId ? `/api/tasks/${encodeURIComponent(taskId)}/messages` : null, useEngineState());

// Why each agent would be skipped as this space's reviewer, or null where it can review. Only the space's own
// settings change the answer, so it's read again when the space is saved rather than on every push.
export const useReviewers = (space: { id: string; updatedAt: number }) =>
  useFetched<Record<string, string | null>>(`/api/spaces/${encodeURIComponent(space.id)}/reviewers`, space.updatedAt);

// A rule's history changes with every automatic approval, undo or renewal, which any state push can mean.
export const useRule = (id: string | null) =>
  useFetched<RuleDetail>(id ? `/api/rules/${encodeURIComponent(id)}` : null, useEngineState());

export async function fetchTranscript(runId: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  try {
    const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/transcript`);
    if (res.status === 404) {
      return { ok: false, error: "This transcript isn't stored anymore. Atrium keeps the newest 200 MB of transcripts." };
    }
    if (!res.ok) return { ok: false, error: `Atrium answered with an error (${res.status}). Try again.` };
    return { ok: true, text: await res.text() };
  } catch {
    return { ok: false, error: "Can't reach the Atrium engine. Check that it's running, then try again." };
  }
}

export type PostResult<T> = { ok: true; data: T } | { ok: false; error: string };

export const post = <T = unknown>(path: string, body?: unknown) => send<T>("POST", path, body);
export const patch = <T = unknown>(path: string, body: unknown) => send<T>("PATCH", path, body);

async function send<T>(method: "POST" | "PATCH", path: string, body?: unknown): Promise<PostResult<T>> {
  try {
    const res = await fetch(path, {
      method,
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res.ok) return { ok: false, error: data?.error ?? `Atrium answered with an error (${res.status}). Try again.` };
    return { ok: true, data: data as T };
  } catch {
    return { ok: false, error: "Can't reach the Atrium engine. Check that it's running, then try again." };
  }
}
