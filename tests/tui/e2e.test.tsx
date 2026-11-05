import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Server } from "bun";
import { cleanup, render } from "ink-testing-library";
import { listPending } from "../../src/engine/approvals";
import { openDb } from "../../src/engine/db";
import { bus } from "../../src/engine/events";
import { createTask, setTaskStatus } from "../../src/engine/tasks";
import { startServer } from "../../src/server/server";
import { createClient, type EngineClient } from "../../src/tui/client";
import { App } from "../../src/tui/components/App";
import { tempHome } from "../helpers";
import { seedReview } from "./seed";

let home: ReturnType<typeof tempHome>;
let db: Database;
let server: Server<undefined>;
let client: EngineClient;
let stateFetches: number;
const realFetch = globalThis.fetch;

beforeEach(() => {
  home = tempHome();
  db = openDb();
  server = startServer({ db, runner: { kick: () => {} }, setup: async () => { throw new Error("no setup"); }, port: 0 });
  stateFetches = 0;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/api/state")) stateFetches++;
    return realFetch(input, init);
  }) as typeof fetch;
  client = createClient({ base: `http://127.0.0.1:${server.port}` });
});
afterEach(async () => {
  cleanup();
  client.close();
  globalThis.fetch = realFetch;
  await server.stop(true);
  db.close();
  home.cleanup();
});

function open() {
  const size = { columns: 120, rows: 36 };
  const tree = <App client={client} size={size} />;
  const r = render(tree);
  Object.defineProperty(r.stdout, "columns", { get: () => size.columns });
  r.rerender(tree);
  const frame = async (pred: (f: string) => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    // Real network in between, so this one checks on a short interval instead of per render.
    while (Date.now() < end) {
      if (pred(r.lastFrame() ?? "")) return r.lastFrame()!;
      await new Promise((res) => setTimeout(res, 10));
    }
    throw new Error(`no matching frame; last frame:\n${r.lastFrame()}`);
  };
  const type = async (...keys: string[]) => {
    for (const k of keys) {
      r.stdin.write(k);
      await new Promise((res) => setTimeout(res, 10));
    }
  };
  return { ...r, frame, type };
}

test("approving in the terminal resolves it in the engine", async () => {
  seedReview(db);
  const app = open();
  await app.frame((f) => f.includes("[3] Needs you · 1"));
  await app.type("3", "a");
  await app.frame((f) => f.includes("You're all caught up."));
  expect(listPending(db)).toEqual([]);
});

test("a change in the engine shows up without polling", async () => {
  const { space } = seedReview(db);
  const app = open();
  await app.frame((f) => f.includes("[2] Tasks · atrium"));
  await new Promise((r) => setTimeout(r, 100));
  const before = stateFetches;
  await new Promise((r) => setTimeout(r, 500));
  expect(stateFetches).toBe(before);
  createTask(db, { spaceId: space.id, title: "Write the changelog" });
  await app.frame((f) => f.includes("Write the changelog"));
  expect(stateFetches).toBe(before + 1);
});

test("live output streams in", async () => {
  const { space } = seedReview(db);
  const task = createTask(db, { spaceId: space.id, title: "Run the build" });
  setTaskStatus(db, task.id, "running");
  db.query("INSERT INTO runs (id, task_id, agent, started_at, transcript_path) VALUES (?, ?, ?, ?, ?)").run(
    "run_live", task.id, "claude", Date.now(), `${home.home}/missing.log`,
  );
  bus.emit({ type: "changed" });
  const app = open();
  await app.frame((f) => f.includes("Claude · running"));
  bus.emit({ type: "run-output", runId: "run_live", taskId: task.id, chunk: "hello from the agent" });
  await app.frame((f) => f.includes("hello from the agent"));
});
