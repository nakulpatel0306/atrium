import { readFileSync } from "node:fs";
import { join } from "node:path";

export const fixture = (name: string): string => readFileSync(join(import.meta.dir, "../../fixtures/markets", name), "utf8");

export type Call = { url: URL; headers: Record<string, string> };

// A fetch stand-in that records each request and answers from a handler.
export function stubFetch(handler: (url: URL, call: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({ url, headers });
    return handler(url, calls.length);
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

export const jsonResponse = (body: unknown, status = 200) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  sent: unknown[] = [];
  closed = false;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.({});
  }
  receive(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop() {
    this.onclose?.({ code: 1006 });
  }
}

// Timers that only fire when the test says so; records every delay asked for.
export function fakeTimers() {
  let seq = 0;
  const pending = new Map<number, { fn: () => void; delay: number }>();
  const delays: number[] = [];
  return {
    delays,
    pending,
    set: ((fn: () => void, delay: number) => {
      const id = ++seq;
      pending.set(id, { fn, delay });
      delays.push(delay);
      return id;
    }) as unknown as typeof setTimeout,
    clear: ((id: number) => {
      pending.delete(id);
    }) as unknown as typeof clearTimeout,
    fireAll() {
      const list = [...pending.entries()];
      pending.clear();
      for (const [, t] of list) t.fn();
    },
  };
}
