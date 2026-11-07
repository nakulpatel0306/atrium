import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Server } from "bun";
import { createApproval, listPending } from "../../src/engine/approvals";
import { openDb } from "../../src/engine/db";
import { bus } from "../../src/engine/events";
import { createSpace } from "../../src/engine/spaces";
import { createTask } from "../../src/engine/tasks";
import { startServer, type WsData } from "../../src/server/server";
import { createClient, type EngineClient, OFFLINE_ERROR } from "../../src/tui/client";
import { tempHome } from "../helpers";

let home: ReturnType<typeof tempHome>;
let db: Database;
let server: Server<WsData>;
let base: string;
let client: EngineClient;
let attempts: number[];
const realFetch = globalThis.fetch;

const serve = (port = 0) =>
  startServer({
    db,
    runner: { kick: () => {} },
    setup: async () => {
      throw new Error("setup not stubbed");
    },
    port,
  });

beforeEach(() => {
  home = tempHome();
  db = openDb();
  server = serve();
  base = `http://127.0.0.1:${server.port}`;
  attempts = [];
  client = createClient({
    base,
    backoff: (n) => {
      attempts.push(n);
      return 20;
    },
  });
});
afterEach(async () => {
  client.close();
  globalThis.fetch = realFetch;
  await server.stop(true);
  db.close();
  home.cleanup();
});

// Resolves once `pred` holds, checking after each notification rather than on a timer.
function until(pred: () => boolean, ms = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (pred()) return resolve();
    const timer = setTimeout(() => {
      off();
      reject(new Error("timed out waiting for the client"));
    }, ms);
    const off = client.subscribe(() => {
      if (!pred()) return;
      clearTimeout(timer);
      off();
      resolve();
    });
  });
}

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

test("gets state over the socket", async () => {
  await until(() => client.state() !== null);
  expect(client.state()?.spaces).toEqual([]);
  createSpace(db, { name: "Job hunt", kind: "general", goal: "g" });
  await until(() => client.state()?.spaces.length === 1);
  expect(client.state()!.spaces[0]!.name).toBe("Job hunt");
});

test("a burst of changes fetches at most twice", async () => {
  await until(() => client.state() !== null);
  await settle(50);
  let fetches = 0;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/api/state")) fetches++;
    return realFetch(input, init);
  }) as typeof fetch;
  for (let i = 0; i < 20; i++) bus.emit({ type: "changed" });
  await settle(300);
  expect(fetches).toBeGreaterThan(0);
  expect(fetches).toBeLessThanOrEqual(2);
});

test("mutations pass the origin guard", async () => {
  const space = createSpace(db, { name: "App", kind: "general", goal: "g" });
  const a = createApproval(db, { spaceId: space.id, kind: "question", title: "Ok?", detail: "" });
  expect(await client.post(`/api/approvals/${a.id}`, { decision: "approve" })).toMatchObject({ ok: true });
  expect(listPending(db)).toEqual([]);
  expect(await client.post(`/api/approvals/${a.id}`, { decision: "approve" })).toEqual({ ok: false, error: "Already handled" });
});

test("run output is coalesced and kept as a tail", async () => {
  await until(() => client.state() !== null);
  client.output("run_x");
  await settle(100);
  let notified = 0;
  const off = client.subscribe(() => void notified++);
  for (let i = 0; i < 100; i++) bus.emit({ type: "run-output", runId: "run_x", taskId: "t", chunk: `line ${i}` });
  await until(() => client.output("run_x").endsWith("line 99\n"));
  await settle(150);
  off();
  expect(client.output("run_x").endsWith("line 99\n")).toBe(true);
  expect(notified).toBeLessThanOrEqual(3);
});

test("reconnects with backoff and refetches", async () => {
  await until(() => client.state() !== null);
  const port = server.port as number;
  await server.stop(true);
  await until(() => !client.online());
  await settle(100);
  expect(attempts.slice(0, 2)).toEqual([1, 2]);
  server = serve(port);
  createSpace(db, { name: "After restart", kind: "general", goal: "g" });
  await until(() => client.online() && client.state()?.spaces.some((s) => s.name === "After restart") === true);
});

test("offline mutations say what to do", async () => {
  await server.stop(true);
  expect(await client.post("/api/seen")).toEqual({ ok: false, error: OFFLINE_ERROR });
});

test("close stops reconnecting", async () => {
  await until(() => client.state() !== null);
  client.close();
  await server.stop(true);
  const before = attempts.length;
  await settle(200);
  expect(attempts.length).toBe(before);
});

test("strings from the engine arrive without escape sequences", async () => {
  createSpace(db, { name: "job\x1b]52;c;Zm9v\x07 hunt\x9b31m", kind: "general", goal: "g\x1b[2J" });
  await until(() => client.state()?.spaces.length === 1);
  const space = client.state()!.spaces[0]!;
  expect(space.name).toBe("job hunt");
  expect(space.goal).toBe("g");
  client.output("run_y");
  bus.emit({ type: "run-output", runId: "run_y", taskId: "t", chunk: "ok\x1b]0;title\x07!" });
  await until(() => client.output("run_y").includes("ok"));
  expect(client.output("run_y")).toBe("ok!\n");
});

test("output for runs no longer listed is let go", async () => {
  await until(() => client.state() !== null);
  client.output("run_gone");
  await settle(50);
  bus.emit({ type: "run-output", runId: "run_gone", taskId: "t", chunk: "old output" });
  await until(() => client.output("run_gone").includes("old output"));
  bus.emit({ type: "changed" });
  await settle(150);
  expect(client.output("run_gone")).toBe("");
});

// The transcript and the live lines come over two connections, so a line already in the transcript can arrive before
// or after it. The engine numbers the lines and says how many the transcript holds; both orders end the same.
async function seededRun(seq: number | null) {
  await server.stop(true);
  server = startServer({ db, runner: { kick: () => {}, outputSeq: () => seq }, setup: async () => { throw new Error("no"); }, port: Number(new URL(base).port) });
  const space = createSpace(db, { name: "App", kind: "general", goal: "g" });
  const task = createTask(db, { spaceId: space.id, title: "Build" });
  const path = `${home.home}/seed.log`;
  await Bun.write(path, "line A\n");
  db.query("INSERT INTO runs (id, task_id, agent, started_at, transcript_path) VALUES (?, ?, ?, ?, ?)").run("run_seed", task.id, "claude", Date.now(), path);
  await until(() => client.state() !== null && client.online(), 5000);
  return task;
}

test("a live line the transcript already has isn't doubled when it arrives before the transcript", async () => {
  const task = await seededRun(1);
  // The transcript fetch is held until both lines are in, so they arrive while it loads.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/transcript")) await gate;
    return realFetch(input, init);
  }) as typeof fetch;
  client.output("run_seed");
  bus.emit({ type: "run-output", runId: "run_seed", taskId: task.id, chunk: "line A", seq: 1 });
  bus.emit({ type: "run-output", runId: "run_seed", taskId: task.id, chunk: "line B", seq: 2 });
  await until(() => client.output("run_seed").includes("line B"));
  release();
  await until(() => client.output("run_seed") === "line A\nline B\n");
});

test("a live line the transcript already has isn't doubled when it arrives after the transcript", async () => {
  const task = await seededRun(1);
  client.output("run_seed");
  await until(() => client.output("run_seed") === "line A\n");
  bus.emit({ type: "run-output", runId: "run_seed", taskId: task.id, chunk: "line A", seq: 1 });
  bus.emit({ type: "run-output", runId: "run_seed", taskId: task.id, chunk: "line B", seq: 2 });
  await until(() => client.output("run_seed").includes("line B"));
  expect(client.output("run_seed")).toBe("line A\nline B\n");
});

test("with an engine that doesn't number lines, lines during the load are matched against the transcript's end", async () => {
  const task = await seededRun(null);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/transcript")) await gate;
    return realFetch(input, init);
  }) as typeof fetch;
  client.output("run_seed");
  bus.emit({ type: "run-output", runId: "run_seed", taskId: task.id, chunk: "line A" });
  bus.emit({ type: "run-output", runId: "run_seed", taskId: task.id, chunk: "line B" });
  await until(() => client.output("run_seed").includes("line B"));
  release();
  await until(() => client.output("run_seed") === "line A\nline B\n");
});

test("a frame that isn't JSON is ignored", async () => {
  let fetches = 0;
  const fake = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      if (new URL(req.url).pathname === "/ws") return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
      fetches++;
      return Response.json({ spaces: [], tasks: [], runs: [], approvals: [], activity: [] });
    },
    websocket: {
      open(ws) {
        ws.send("not json {");
        ws.send(JSON.stringify({ type: "changed" }));
      },
      message() {},
    },
  });
  const other = createClient({ base: `http://127.0.0.1:${fake.port}`, backoff: () => 20 });
  const off = other.subscribe(() => {});
  await settle(300);
  off();
  other.close();
  fake.stop(true);
  expect(other.online()).toBe(true);
  expect(fetches).toBeGreaterThanOrEqual(2);
});

test("markets() reads the glance route", async () => {
  const seen: string[] = [];
  const glance = { portfolio: null, lists: [], earnings: [], advanced: false, paper: null };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push(url);
    if (url.endsWith("/glance")) return new Response(JSON.stringify(glance), { headers: { "content-type": "application/json" } });
    return realFetch(input, init);
  }) as typeof fetch;
  expect(await client.markets("spc_1")).toEqual(glance);
  expect(seen.some((u) => u.endsWith("/api/investing/spc_1/glance"))).toBe(true);
});
