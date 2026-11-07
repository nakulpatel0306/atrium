import type { PostResult } from "../../src/dashboard/api";
import type { Message } from "../../src/engine/messages";
import type { TaskOutputs } from "../../src/engine/outputs/views";
import type { State } from "../../src/engine/state";
import type { SpaceDeletePreview } from "../../src/engine/delete";
import type { EngineClient, MarketsGlance } from "../../src/tui/client";

type Call = { method: string; path: string; body?: unknown };

export type FakeClient = EngineClient & {
  calls: Call[];
  push(state: State | null): void;
  setOnline(v: boolean): void;
  emitOutput(runId: string, text: string): void;
  respond(path: string, result: PostResult<unknown>): void;
};

// An in-memory engine for component tests: state is whatever the test pushes, and every request is recorded.
export function fakeClient(initial: State | null, opts: { online?: boolean } = {}): FakeClient {
  let state = initial;
  let online = opts.online ?? true;
  const outputs = new Map<string, string>();
  const responses = new Map<string, PostResult<unknown>>();
  const listeners = new Set<() => void>();
  const calls: Call[] = [];
  const notify = () => {
    for (const fn of [...listeners]) fn();
  };
  const answer = <T>(method: string, path: string, body?: unknown): Promise<PostResult<T>> => {
    calls.push(body === undefined ? { method, path } : { method, path, body });
    return Promise.resolve((responses.get(path) ?? { ok: true, data: {} }) as PostResult<T>);
  };

  return {
    base: "http://127.0.0.1:7499",
    calls,
    state: () => state,
    online: () => online,
    output: (runId) => outputs.get(runId) ?? "",
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async messages(taskId) {
      const path = `/api/tasks/${taskId}/messages`;
      calls.push({ method: "GET", path });
      const r = responses.get(path);
      return r?.ok ? (r.data as Message[]) : null;
    },
    async outputs(taskId) {
      const path = `/api/tasks/${taskId}/outputs`;
      calls.push({ method: "GET", path });
      const r = responses.get(path);
      return r?.ok ? (r.data as TaskOutputs) : null;
    },
    async reviewers(spaceId) {
      const path = `/api/spaces/${spaceId}/reviewers`;
      calls.push({ method: "GET", path });
      const r = responses.get(path);
      return r?.ok ? (r.data as Record<string, string | null>) : null;
    },
    async markets(spaceId) {
      const path = `/api/investing/${spaceId}/glance`;
      calls.push({ method: "GET", path });
      const r = responses.get(path);
      return r?.ok ? (r.data as MarketsGlance) : null;
    },
    async deletePreview(spaceId) {
      const path = `/api/spaces/${spaceId}/delete-preview`;
      calls.push({ method: "GET", path });
      const r = responses.get(path);
      return r?.ok ? (r.data as SpaceDeletePreview) : null;
    },
    async get<T>(path: string) {
      calls.push({ method: "GET", path });
      const r = responses.get(path);
      return r?.ok ? (r.data as T) : null;
    },
    async transcript(runId) {
      const path = `/api/runs/${runId}/transcript`;
      calls.push({ method: "GET", path });
      const r = responses.get(path);
      if (!r) return { ok: true, text: "" };
      return r.ok ? { ok: true, text: String(r.data) } : r;
    },
    post: (path, body) => answer("POST", path, body),
    patch: (path, body) => answer("PATCH", path, body),
    put: (path, body) => answer("PUT", path, body),
    del: (path, body) => answer("DELETE", path, body),
    close: () => listeners.clear(),
    push(next) {
      state = next;
      notify();
    },
    setOnline(v) {
      online = v;
      notify();
    },
    emitOutput(runId, text) {
      outputs.set(runId, `${outputs.get(runId) ?? ""}${text}\n`);
      notify();
    },
    respond(path, result) {
      responses.set(path, result);
    },
  };
}
