import type { PostResult } from "../dashboard/api";
import { config } from "../engine/config";
import type { Message } from "../engine/messages";
import type { TaskOutputs } from "../engine/outputs/views";
import type { State } from "../engine/state";
import type { GlanceView } from "../engine/markets/views";
import type { SpaceDeletePreview } from "../engine/delete";
import { clean, scrub } from "./text";

export type EngineClient = {
  readonly base: string;
  state(): State | null;
  online(): boolean;
  output(runId: string): string;
  subscribe(fn: () => void): () => void;
  messages(taskId: string): Promise<Message[] | null>;
  outputs(taskId: string): Promise<TaskOutputs | null>;
  reviewers(spaceId: string): Promise<Record<string, string | null> | null>;
  markets(spaceId: string): Promise<MarketsGlance | null>;
  deletePreview(spaceId: string): Promise<SpaceDeletePreview | null>;
  transcript(runId: string): Promise<{ ok: true; text: string } | { ok: false; error: string }>;
  post<T = unknown>(path: string, body?: unknown): Promise<PostResult<T>>;
  patch<T = unknown>(path: string, body: unknown): Promise<PostResult<T>>;
  del<T = unknown>(path: string, body?: unknown): Promise<PostResult<T>>;
  close(): void;
};

// The few investing numbers the terminal shows; charts and the rest stay in the app.
export type MarketsGlance = GlanceView;

export const engineBase = () => `http://${config().host}:${config().port}`;

export const OFFLINE_ERROR = "Can't reach the Atrium engine. Check that it's running, then try again.";
const MISSING_TRANSCRIPT = "This transcript isn't stored anymore. Atrium keeps the newest 200 MB of transcripts.";
const engineError = (status: number) => `Atrium couldn't do that (error ${status}). Try again, and check the engine log if it keeps happening.`;

type EngineMessage = { type: "changed" } | { type: "run-output"; runId: string; taskId: string; chunk: string };

// Live output is only for watching; the full record is the transcript, so keep just the tail.
const OUTPUT_TAIL = 200_000;
// Output arrives a line at a time; one redraw per batch keeps a chatty agent from pinning the CPU.
const OUTPUT_BATCH_MS = 50;

// The DOM lib's constructor type wins over Bun's, which also takes headers.
const BunSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;

const KEEP_RUNS = 20;
const KEEP_ENDED_MS = 10 * 60_000;

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
  const loading = new Map<string, string[]>();
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
        prune(state.runs);
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
      let msg: EngineMessage;
      try {
        msg = JSON.parse(String(ev.data)) as EngineMessage;
      } catch {
        // A frame that isn't JSON isn't from this engine version; skip it rather than drop the connection.
        return;
      }
      if (msg.type === "changed") {
        void refresh();
      } else if (msg.type === "run-output") {
        const line = clean(msg.chunk);
        // Held while the run's transcript loads, then merged onto it without repeating what it already has.
        loading.get(msg.runId)?.push(line);
        // Chunks are whole lines without their newline, the same as the transcript stores them.
        outputs.set(msg.runId, `${outputs.get(msg.runId) ?? ""}${line}\n`.slice(-OUTPUT_TAIL));
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
    loading.set(runId, []);
    const res = await transcript(runId);
    const during = loading.get(runId) ?? [];
    loading.delete(runId);
    if (!res.ok || closed) return;
    // Lines that arrived during the fetch may already be in the transcript (written before they were sent);
    // only the ones after its end are new.
    let skip = during.length;
    while (skip > 0 && !res.text.endsWith(`${during.slice(0, skip).join("\n")}\n`)) skip--;
    const fresh = during.slice(skip).map((l) => `${l}\n`).join("");
    outputs.set(runId, (res.text + fresh).slice(-OUTPUT_TAIL));
    notify();
  }

  // Output is only for watching while a run is recent; older runs are read from their transcript instead.
  function prune(runs: State["runs"]): void {
    const now = Date.now();
    const keep = new Set(
      runs.slice(0, KEEP_RUNS).flatMap((r) => (r.endedAt === null || now - r.endedAt < KEEP_ENDED_MS ? [r.id] : [])),
    );
    for (const id of [...outputs.keys(), ...seeded]) {
      if (keep.has(id) || loading.has(id)) continue;
      outputs.delete(id);
      seeded.delete(id);
    }
  }

  async function read<T>(path: string): Promise<T | null> {
    try {
      const res = await fetch(base + path);
      return res.ok ? scrub((await res.json()) as T) : null;
    } catch {
      return null;
    }
  }

  async function send<T>(method: "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<PostResult<T>> {
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
    outputs: (taskId) => read<TaskOutputs>(`/api/tasks/${encodeURIComponent(taskId)}/outputs`),
    reviewers: (spaceId) => read<Record<string, string | null>>(`/api/spaces/${encodeURIComponent(spaceId)}/reviewers`),
    markets: (spaceId) => read<GlanceView>(`/api/investing/${encodeURIComponent(spaceId)}/glance`),
    deletePreview: (spaceId) => read<SpaceDeletePreview>(`/api/spaces/${encodeURIComponent(spaceId)}/delete-preview`),
    transcript,
    post: (path, body) => send("POST", path, body),
    patch: (path, body) => send("PATCH", path, body),
    del: (path, body) => send("DELETE", path, body),
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
