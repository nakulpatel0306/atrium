import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Message } from "../engine/messages";
import type { State } from "../engine/state";
import type { EngineClient, MarketsGlance } from "./client";

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

// Prices and paper P&L move with every quote, so this is read again on any state push while the space is open.
export function useMarketsGlance(c: EngineClient, space: Space | null): MarketsGlance | null {
  const state = useEngineState(c);
  return useFetched(space?.id ?? null, state, () => c.markets(space!.id));
}

type Transcript = { ok: true; text: string } | { ok: false; error: string };
const KEEP_TRANSCRIPTS = 20;
type RunRef = { id: string; endedAt: number | null };

// A finished run's transcript never changes, so it's fetched once and kept. A live run's isn't cached: its
// transcript is still growing, and the client's live output (seeded from the transcript) is the current text.
export function useTranscript(c: EngineClient, run: RunRef | null): Transcript | null {
  const cache = useRef(new Map<string, Transcript>());
  const [, setLoaded] = useState(0);
  const live = useRunOutput(c, run && run.endedAt === null ? run.id : null);
  const key = run && run.endedAt !== null ? `${run.id}:${run.endedAt}` : null;
  useEffect(() => {
    if (!key || !run || cache.current.has(key)) return;
    void c.transcript(run.id).then((res) => {
      cache.current.set(key, res);
      // Up to 5 MB each; keep the most recently opened few.
      for (const old of [...cache.current.keys()].slice(0, Math.max(0, cache.current.size - KEEP_TRANSCRIPTS))) cache.current.delete(old);
      setLoaded((n) => n + 1);
    });
  }, [key, c]);
  if (!run) return null;
  if (run.endedAt === null) return { ok: true, text: live };
  return cache.current.get(key!) ?? null;
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
