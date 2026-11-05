import type { PostResult } from "../dashboard/api";
import { config } from "../engine/config";
import type { Message } from "../engine/messages";
import type { State } from "../engine/state";
import { clean, scrub } from "./text";

export type EngineClient = {
  readonly base: string;
  state(): State | null;
  online(): boolean;
  output(runId: string): string;
  subscribe(fn: () => void): () => void;
  messages(taskId: string): Promise<Message[] | null>;
  reviewers(spaceId: string): Promise<Record<string, string | null> | null>;
  transcript(runId: string): Promise<{ ok: true; text: string } | { ok: false; error: string }>;
  post<T = unknown>(path: string, body?: unknown): Promise<PostResult<T>>;
  patch<T = unknown>(path: string, body: unknown): Promise<PostResult<T>>;
  close(): void;
};

export const engineBase = () => `http://${config().host}:${config().port}`;

export const OFFLINE_ERROR = "Can't reach the Atrium engine. Check that it's running, then try again.";
const MISSING_TRANSCRIPT = "This transcript isn't stored anymore. Atrium keeps the newest 200 MB of transcripts.";
const engineError = (status: number) => `Atrium answered with an error (${status}). Try again.`;

type EngineMessage = { type: "changed" } | { type: "run-output"; runId: string; taskId: string; chunk: string };

// Live output is only for watching; the full record is the transcript, so keep just the tail.
const OUTPUT_TAIL = 200_000;
// Output arrives a line at a time; one redraw per batch keeps a chatty agent from pinning the CPU.
const OUTPUT_BATCH_MS = 50;

// The DOM lib's constructor type wins over Bun's, which also takes headers.
const BunSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;

const defaultBackoff = (attempt: number) => Math.min(2000 * 2 ** (attempt - 1), 30_000);

export function createClient(opts: { base?: string; backoff?: (attempt: number) => number } = {}): EngineClient {
  const base = opts.base ?? engineBase();
  const backoff = opts.backoff ?? defaultBackoff;
  // The engine's guard wants an Origin on mutations and the socket upgrade; Bun's fetch sets Host itself.
  const origin = { Origin: base };

  let state: State | null = null;
  let online = true;
  let closed = false;
  let ws: WebSocket | null = null;
  let attempt = 0;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let batch: ReturnType<typeof setTimeout> | null = null;
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
      const res = await fetch(`${base}/api/state`);
      if (res.ok && !closed) {
        state = scrub((await res.json()) as State);
        notify();
      }
    } catch {
      // The socket's close handler shows the offline state and refetches on reconnect.
    } finally {
      fetching = false;
      if (refetch) {
        refetch = false;
        void refresh();
      }
    }
  }

  function connect(): void {
    retry = null;
    if (closed) return;
    const socket = new BunSocket(`${base.replace(/^http/, "ws")}/ws`, { headers: origin });
    ws = socket;
    socket.onopen = () => {
      attempt = 0;
      online = true;
      notify();
      void refresh();
    };
    socket.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as EngineMessage;
      if (msg.type === "changed") {
        void refresh();
      } else if (msg.type === "run-output") {
        // Chunks are whole lines without their newline, the same as the transcript stores them.
        outputs.set(msg.runId, `${outputs.get(msg.runId) ?? ""}${clean(msg.chunk)}\n`.slice(-OUTPUT_TAIL));
        batch ??= setTimeout(() => {
          batch = null;
          notify();
        }, OUTPUT_BATCH_MS);
      }
    };
    socket.onclose = () => {
      if (ws === socket) ws = null;
      if (closed) return;
      if (online) {
        online = false;
        notify();
      }
      attempt += 1;
      retry = setTimeout(connect, backoff(attempt));
    };
  }

  async function transcript(runId: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    try {
      const res = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}/transcript`);
      if (res.status === 404) return { ok: false, error: MISSING_TRANSCRIPT };
      if (!res.ok) return { ok: false, error: engineError(res.status) };
      return { ok: true, text: clean(await res.text()) };
    } catch {
      return { ok: false, error: OFFLINE_ERROR };
    }
  }

  // A run that started before the app opened has output only in its transcript, so start from that.
  async function seed(runId: string): Promise<void> {
    seeded.add(runId);
    const res = await transcript(runId);
    if (!res.ok || closed) return;
    // Chunks that arrived during the fetch were written to the transcript before they were sent.
    outputs.set(runId, clean(res.text).slice(-OUTPUT_TAIL));
    notify();
  }

  async function read<T>(path: string): Promise<T | null> {
    try {
      const res = await fetch(base + path);
      return res.ok ? scrub((await res.json()) as T) : null;
    } catch {
      return null;
    }
  }

  async function send<T>(method: "POST" | "PATCH", path: string, body?: unknown): Promise<PostResult<T>> {
    try {
      const res = await fetch(base + path, {
        method,
        headers: { ...origin, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = scrub((await res.json().catch(() => null)) as (T & { error?: string }) | null);
      if (!res.ok) return { ok: false, error: data?.error ?? engineError(res.status) };
      return { ok: true, data: data as T };
    } catch {
      return { ok: false, error: OFFLINE_ERROR };
    }
  }

  return {
    base,
    state: () => state,
    online: () => online,
    output(runId) {
      if (!seeded.has(runId)) void seed(runId);
      return outputs.get(runId) ?? "";
    },
    subscribe(fn) {
      listeners.add(fn);
      if (!ws && !retry && !closed) connect();
      return () => listeners.delete(fn);
    },
    messages: (taskId) => read<Message[]>(`/api/tasks/${encodeURIComponent(taskId)}/messages`),
    reviewers: (spaceId) => read<Record<string, string | null>>(`/api/spaces/${encodeURIComponent(spaceId)}/reviewers`),
    transcript,
    post: (path, body) => send("POST", path, body),
    patch: (path, body) => send("PATCH", path, body),
    close() {
      closed = true;
      if (retry) clearTimeout(retry);
      if (batch) clearTimeout(batch);
      retry = batch = null;
      ws?.close();
      ws = null;
      listeners.clear();
    },
  };
}
