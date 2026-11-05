import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Message } from "../engine/messages";
import type { State } from "../engine/state";
import type { EngineClient } from "./client";

type Space = State["spaces"][number];

export const useEngineState = (c: EngineClient): State | null => useSyncExternalStore(c.subscribe, c.state);

export const useOnline = (c: EngineClient): boolean => useSyncExternalStore(c.subscribe, c.online);

export function useRunOutput(c: EngineClient, runId: string | null): string {
  return useSyncExternalStore(c.subscribe, () => (runId ? c.output(runId) : ""));
}

// Reads data that isn't part of the pushed state, again whenever `version` changes.
function useFetched<T>(key: string | null, version: unknown, load: () => Promise<T | null>): T | null {
  const [data, setData] = useState<{ key: string; value: T } | null>(null);
  useEffect(() => {
    if (!key) return;
    let live = true;
    // A failed read keeps what's shown; the next change tries again.
    void load().then((value) => live && value !== null && setData({ key, value }));
    return () => {
      live = false;
    };
  }, [key, version]);
  return data && data.key === key ? data.value : null;
}

// A thread grows as agents hand work back and forth, which any state push can mean.
export function useMessages(c: EngineClient, taskId: string | null): Message[] | null {
  const state = useEngineState(c);
  return useFetched(taskId, state, () => c.messages(taskId!));
}

// Only the space's own settings change the answer, so it's read again when the space is saved.
export function useReviewers(c: EngineClient, space: Space | null): Record<string, string | null> | null {
  return useFetched(space?.id ?? null, space?.updatedAt, () => c.reviewers(space!.id));
}

type Transcript = { ok: true; text: string } | { ok: false; error: string };

// Fetched once per run opened; a transcript only grows while its run is live, and Live shows that. Null while loading.
export function useTranscript(c: EngineClient, runId: string | null): Transcript | null {
  const cache = useRef(new Map<string, Transcript>());
  const [, setLoaded] = useState(0);
  useEffect(() => {
    if (!runId || cache.current.has(runId)) return;
    void c.transcript(runId).then((res) => {
      cache.current.set(runId, res);
      setLoaded(cache.current.size);
    });
  }, [runId, c]);
  return runId ? (cache.current.get(runId) ?? null) : null;
}

// Redraws on an interval so relative times stay true; only while `active`, so an idle screen does no work.
export function useTick(ms: number, active: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [ms, active]);
}
