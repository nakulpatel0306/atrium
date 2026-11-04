import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Server } from "bun";
import { createApproval, listPending } from "../../src/engine/approvals";
import { openDb } from "../../src/engine/db";
import { createRunner } from "../../src/engine/runner";
import { SetupFailed } from "../../src/engine/setup";
import { createSpace } from "../../src/engine/spaces";
import { getSetting } from "../../src/engine/settings";
import { createTask, getTask, listTasks, setTaskStatus } from "../../src/engine/tasks";
import { startServer } from "../../src/server/server";
import { tempHome } from "../helpers";

let home: ReturnType<typeof tempHome>;
let db: Database;
let server: Server<undefined>;
let kicks: number;
let setupImpl: (text: string) => Promise<never>;
let base: string;
let origin: string;

beforeEach(() => {
  home = tempHome();
  db = openDb();
  kicks = 0;
  setupImpl = async () => {
    throw new Error("setup not stubbed");
  };
  server = startServer({
    db,
    runner: { kick: () => void kicks++ },
    setup: (t) => setupImpl(t),
    port: 0,
  });
  base = `http://127.0.0.1:${server.port}`;
  origin = base;
});
afterEach(() => {
  server.stop(true);
  db.close();
  home.cleanup();
});

const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, {
    method: "POST",
    headers: { origin, "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

test("GET /api/state returns spaces and briefing", async () => {
  createSpace(db, { name: "Docs", kind: "general", goal: "write" });
  const res = await fetch(`${base}/api/state`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { spaces: unknown[]; briefing: unknown };
  expect(body.spaces).toHaveLength(1);
  expect(body.briefing).toBeDefined();
});

test("POST /api/tasks creates and kicks the runner", async () => {
  const s = createSpace(db, { name: "Docs", kind: "general", goal: "write" });
  const res = await post("/api/tasks", { spaceId: s.id, title: "Draft" });
  expect(res.status).toBe(200);
  expect(listTasks(db)).toHaveLength(1);
  expect(kicks).toBe(1);
});

test("second approval resolve returns 409", async () => {
  const s = createSpace(db, { name: "Docs", kind: "general", goal: "write" });
  const a = createApproval(db, { spaceId: s.id, kind: "question", title: "Q", detail: "?" });
  expect((await post(`/api/approvals/${a.id}`, { decision: "approve" })).status).toBe(200);
  const again = await post(`/api/approvals/${a.id}`, { decision: "approve" });
  expect(again.status).toBe(409);
  expect(await again.json()).toEqual({ error: "Already handled" });
});

test("unknown approval id returns 404", async () => {
  const res = await post("/api/approvals/apr_nope", { decision: "approve" });
  expect(res.status).toBe(404);
  expect(((await res.json()) as { error: string }).error).toBe("No such approval.");
});

test("command without spaceId calls setup; SetupFailed maps to 422 with message", async () => {
  const s = createSpace(db, { name: "Docs", kind: "general", goal: "write" });
  const seen: string[] = [];
  setupImpl = async (t) => {
    seen.push(t);
    return { space: s, tasks: [] } as never;
  };
  const ok = await post("/api/command", { text: "set up docs" });
  expect(ok.status).toBe(200);
  expect(seen).toEqual(["set up docs"]);

  setupImpl = async () => {
    throw new SetupFailed("Couldn't plan that one.");
  };
  const bad = await post("/api/command", { text: "x" });
  expect(bad.status).toBe(422);
  expect(await bad.json()).toEqual({ error: "Couldn't plan that one." });
});

test("command with spaceId creates a light task in a general space", async () => {
  const s = createSpace(db, { name: "Docs", kind: "general", goal: "write" });
  const res = await post("/api/command", { text: "Draft the intro", spaceId: s.id });
  const { task } = (await res.json()) as { task: { weight: string; title: string } };
  expect(task.weight).toBe("light");
  expect(task.title).toBe("Draft the intro");
  expect(kicks).toBe(1);
});

test("retry requeues a failed or blocked task; other statuses are 409", async () => {
  const s = createSpace(db, { name: "Docs", kind: "general", goal: "write" });
  const t = createTask(db, { spaceId: s.id, title: "T" });
  const bad = await post(`/api/tasks/${t.id}/retry`);
  expect(bad.status).toBe(409);
  expect(await bad.json()).toEqual({ error: "This task isn't blocked or failed, so there's nothing to retry." });
  setTaskStatus(db, t.id, "running");
  setTaskStatus(db, t.id, "failed");
  const ok = await post(`/api/tasks/${t.id}/retry`);
  expect(ok.status).toBe(200);
  expect(getTask(db, t.id)!.status).toBe("queued");
  setTaskStatus(db, t.id, "blocked", { blockedReason: "stuck" });
  expect((await post(`/api/tasks/${t.id}/retry`)).status).toBe(200);
  expect(getTask(db, t.id)!.status).toBe("queued");
  expect((await post("/api/tasks/tsk_nope/retry")).status).toBe(404);
});

test("retry on a running task is 409 and the agent runs once", async () => {
  const s = createSpace(db, { name: "Docs", kind: "general", goal: "write" });
  const t = createTask(db, { spaceId: s.id, title: "T", weight: "light" });
  let calls = 0;
  let finish!: () => void;
  const gate = new Promise<void>((r) => (finish = r));
  const runner = createRunner({
    db,
    adapters: {
      claude: {
        id: "claude",
        label: "Fake",
        async run() {
          calls++;
          await gate;
          return { status: "ok", summary: "done", inputTokens: 1, outputTokens: 1 };
        },
      },
    },
    power: async () => "ac",
    keepAwake: { start() {}, stop() {}, active: () => false },
  });
  server.stop(true);
  server = startServer({ db, runner, setup: (x) => setupImpl(x), port: 0 });
  base = origin = `http://127.0.0.1:${server.port}`;
  runner.start();
  try {
    while (getTask(db, t.id)!.status !== "running") await Bun.sleep(5);
    const res = await post(`/api/tasks/${t.id}/retry`);
    expect(res.status).toBe(409);
    finish();
    while (getTask(db, t.id)!.status !== "review") await Bun.sleep(5);
    await Bun.sleep(30);
    expect(calls).toBe(1);
  } finally {
    await runner.stop();
  }
});

test("retry on a task in review is 409 and its approval stays pending", async () => {
  const s = createSpace(db, { name: "Docs", kind: "general", goal: "write" });
  const t = createTask(db, { spaceId: s.id, title: "T" });
  setTaskStatus(db, t.id, "running");
  setTaskStatus(db, t.id, "review");
  const a = createApproval(db, { spaceId: s.id, taskId: t.id, kind: "review", title: "T", detail: "d" });
  expect((await post(`/api/tasks/${t.id}/retry`)).status).toBe(409);
  expect(getTask(db, t.id)!.status).toBe("review");
  expect(listPending(db).map((p) => p.id)).toEqual([a.id]);
});

test("settings writes overnight as a string and kicks", async () => {
  const res = await post("/api/settings", { overnight: true });
  expect(res.status).toBe(200);
  expect(getSetting(db, "overnight")).toBe("true");
  expect(kicks).toBe(1);
  expect((await post("/api/settings", { overnight: "yes" })).status).toBe(400);
});

test("transcript is served from the run's stored path only", async () => {
  const s = createSpace(db, { name: "Docs", kind: "general", goal: "write" });
  const t = createTask(db, { spaceId: s.id, title: "T" });
  const path = `${home.home}/t.log`;
  await Bun.write(path, "hello transcript");
  db.query("INSERT INTO runs (id, task_id, agent, started_at, transcript_path) VALUES (?, ?, ?, ?, ?)").run(
    "run_1", t.id, "claude", Date.now(), path,
  );
  const res = await fetch(`${base}/api/runs/run_1/transcript`);
  expect(res.headers.get("content-type")).toContain("text/plain");
  expect(await res.text()).toBe("hello transcript");
  expect((await fetch(`${base}/api/runs/nope/transcript`)).status).toBe(404);
});

test("server is bound to 127.0.0.1", () => {
  expect(server.hostname).toBe("127.0.0.1");
});

test("dashboard routes serve html", async () => {
  for (const p of ["/", "/space/spc_1"]) {
    const res = await fetch(base + p);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>Atrium</title>");
  }
});

test("wrong Host header is 403", async () => {
  const res = await fetch(`${base}/api/state`, { headers: { host: "evil.example" } });
  expect(res.status).toBe(403);
});

test("POST without Origin or with a foreign Origin is 403; allowed Origin works", async () => {
  const noOrigin = await fetch(`${base}/api/seen`, { method: "POST" });
  expect(noOrigin.status).toBe(403);
  expect((await post("/api/seen", undefined, { origin: "http://evil.example" })).status).toBe(403);
  expect((await post("/api/seen", undefined, { origin: `http://localhost:${server.port}` })).status).toBe(200);
  expect((await post("/api/seen")).status).toBe(200);
});

test("non-JSON content-type is 415", async () => {
  const text = await fetch(`${base}/api/settings`, {
    method: "POST",
    headers: { origin, "content-type": "text/plain" },
    body: '{"overnight":true}',
  });
  expect(text.status).toBe(415);
});

test("unexpected errors return the generic 500 and log the cause", async () => {
  const spy = spyOn(console, "error").mockImplementation(() => {});
  const res = await post("/api/command", { text: "x" });
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ error: "Something went wrong in Atrium. Check the engine log." });
  expect(spy).toHaveBeenCalled();
  spy.mockRestore();
});

test("unknown route is 404", async () => {
  expect((await fetch(`${base}/api/nope`)).status).toBe(404);
});

const openWs = (headers: Record<string, string>) =>
  new Promise<{ ws: WebSocket; ok: boolean }>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers } as never);
    ws.onopen = () => resolve({ ws, ok: true });
    ws.onerror = () => resolve({ ws, ok: false });
  });

test("ws receives changed after a mutation", async () => {
  const { ws, ok } = await openWs({ origin });
  expect(ok).toBe(true);
  const got = new Promise<string>((resolve) => (ws.onmessage = (m) => resolve(String(m.data))));
  await post("/api/spaces", { name: "New", kind: "general", goal: "g" });
  expect(JSON.parse(await got)).toEqual({ type: "changed" });
  ws.close();
});

test("ws upgrade with a foreign Origin is rejected", async () => {
  const { ok } = await openWs({ origin: "http://evil.example" });
  expect(ok).toBe(false);
});
