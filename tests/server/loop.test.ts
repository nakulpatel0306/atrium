import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Server } from "bun";
import type { Registry } from "../../src/engine/agents/registry";
import type { AgentAdapter, AgentRunInput } from "../../src/engine/agents/types";
import { normalizeBrief } from "../../src/engine/brief";
import { saveChecks } from "../../src/engine/checks/run";
import { openDb } from "../../src/engine/db";
import { newLoop, SIZE_BUDGETS } from "../../src/engine/loop";
import { createSpace } from "../../src/engine/spaces";
import { createTask, getTask, setTaskLoop, setTaskStatus } from "../../src/engine/tasks";
import { startServer, type WsData } from "../../src/server/server";
import { tempHome, tempRepo } from "../helpers";

let home: ReturnType<typeof tempHome>;
let db: Database;
let server: Server<WsData>;
let base: string;
let kicks: number;
const briefCalls: AgentRunInput[] = [];

const claude: AgentAdapter = {
  id: "claude",
  label: "Claude Code",
  async run(input) {
    briefCalls.push(input);
    return { status: "ok", summary: JSON.stringify({ goal: "Show totals", acceptance: [], size: "small", questions: [{ question: "Which page?", options: ["Home", "Report"] }] }), inputTokens: 1, outputTokens: 1 };
  },
};

beforeEach(() => {
  home = tempHome();
  db = openDb();
  kicks = 0;
  briefCalls.length = 0;
  server = startServer({
    db,
    runner: { kick: () => void kicks++, registry: { adapters: { claude } } as unknown as Registry },
    setup: async () => {
      throw new Error("setup not stubbed");
    },
    port: 0,
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterEach(() => {
  server.stop(true);
  db.close();
  home.cleanup();
});

const post = (path: string, body: unknown = {}) =>
  fetch(base + path, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify(body) });

test("the brief route drafts a brief with questions, the repo's checks and gap hints", async () => {
  const repo = tempRepo();
  const s = createSpace(db, { name: "App", kind: "repo", goal: "", repoPath: repo.path });
  const res = await post("/api/brief", { spaceId: s.id, text: "totals on the report" });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { brief: { goal: string; size: string }; questions: unknown[]; checks: string[]; hints: string[] };
  expect(body.brief.goal).toBe("Show totals");
  expect(body.questions).toEqual([{ question: "Which page?", options: ["Home", "Report"] }]);
  expect(body.checks).toEqual([]);
  expect(body.hints).toContain("No way to check this is done: add a test command or acceptance check.");
  expect(briefCalls[0]!.model).toBe("haiku");
  expect(briefCalls[0]!.cwd).toBe(repo.path);
  expect((await post("/api/brief", { spaceId: s.id, text: "  " })).status).toBe(400);
  repo.cleanup();
});

test("a task sent with a brief keeps it; one sent straight away has none", async () => {
  const s = createSpace(db, { name: "App", kind: "general", goal: "" });
  const withBrief = (await (await post("/api/command", { spaceId: s.id, text: "release notes", brief: { goal: "Draft notes", acceptance: ["Covers every change"], junk: 1 } })).json()) as { task: { id: string } };
  expect(getTask(db, withBrief.task.id)!.brief).toEqual(normalizeBrief({ goal: "Draft notes", acceptance: ["Covers every change"] }));
  const quick = (await (await post("/api/command", { spaceId: s.id, text: "release notes" })).json()) as { task: { id: string } };
  expect(getTask(db, quick.task.id)!.brief).toBeNull();
});

test("a task's latest checks are listed for its badge", async () => {
  const s = createSpace(db, { name: "App", kind: "general", goal: "" });
  const t = createTask(db, { spaceId: s.id, title: "Fix" });
  saveChecks(db, t.id, null, [{ name: "Tests", command: "bun test", kind: "full", status: "failed", exitCode: 1, output: "1 fail", durationMs: 3 }]);
  const rows = (await (await fetch(`${base}/api/tasks/${t.id}/checks`)).json()) as { status: string; output: string }[];
  expect(rows.map((r) => [r.status, r.output])).toEqual([["failed", "1 fail"]]);
});

function pausedTask() {
  const s = createSpace(db, { name: "App", kind: "general", goal: "" });
  const t = createTask(db, { spaceId: s.id, title: "Fix" });
  setTaskLoop(db, t.id, { ...newLoop(SIZE_BUDGETS.small), paused: { kind: "loop", diagnosis: "x" }, stalled: 3, usage: { tokens: 9, ms: 9, unreported: false } });
  setTaskStatus(db, t.id, "blocked", { blockedReason: "Paused: x" });
  return t;
}

test("a hint requeues a paused task with the note and fresh counters; explain asks for a diagnosis", async () => {
  const t = pausedTask();
  expect((await post(`/api/tasks/${t.id}/hint`, { note: "" })).status).toBe(400);
  expect((await post(`/api/tasks/${t.id}/hint`, { note: "Use the cached value" })).status).toBe(200);
  const hinted = getTask(db, t.id)!;
  expect(hinted.status).toBe("queued");
  expect(hinted.detail).toContain("Hint from you after a pause: Use the cached value");
  expect([hinted.loop!.paused, hinted.loop!.stalled, hinted.loop!.usage.tokens]).toEqual([null, 0, 0]);
  expect((await post(`/api/tasks/${t.id}/explain`)).status).toBe(409);

  const other = pausedTask();
  expect((await post(`/api/tasks/${other.id}/explain`)).status).toBe(200);
  expect(getTask(db, other.id)!.loop!.explain).toBe(true);
  expect(getTask(db, other.id)!.status).toBe("queued");
  expect(kicks).toBe(2);
});

test("retrying a paused task starts its budget over; a budget can be changed until it's done", async () => {
  const t = pausedTask();
  expect((await post(`/api/tasks/${t.id}/budget`, { budget: { tokens: 50000, minutes: 5 } })).status).toBe(200);
  expect(getTask(db, t.id)!.loop!.budget).toEqual({ tokens: 50000, minutes: 5 });
  expect((await post(`/api/tasks/${t.id}/budget`, { budget: { tokens: 1.5, minutes: 5 } })).status).toBe(400);
  expect((await post(`/api/tasks/${t.id}/retry`)).status).toBe(200);
  expect(getTask(db, t.id)!.loop!.usage.tokens).toBe(0);
});
