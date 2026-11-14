import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Server } from "bun";
import type { Registry } from "../../src/engine/agents/registry";
import type { AgentAdapter, AgentRunInput } from "../../src/engine/agents/types";
import { normalizeBrief } from "../../src/engine/brief";
import { saveChecks } from "../../src/engine/checks/run";
import { openDb } from "../../src/engine/db";
import { newLoop, SIZE_BUDGETS } from "../../src/engine/loop";
import { proposeShape, runNow } from "../../src/engine/shape";
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

test("accepting a suggested check is what sets the brief's verify; without a suggestion there's nothing to accept", async () => {
  const s = createSpace(db, { name: "App", kind: "repo", goal: "", repoPath: "/tmp/x" });
  const t = createTask(db, { spaceId: s.id, title: "Fix", brief: normalizeBrief({ goal: "Fix" }) });
  setTaskLoop(db, t.id, { ...newLoop(SIZE_BUDGETS.small), suggestedVerify: "bun test tests/api" });
  expect((await post(`/api/tasks/${t.id}/accept-verify`)).status).toBe(200);
  expect(getTask(db, t.id)!.brief!.verify).toBe("bun test tests/api");
  expect(getTask(db, t.id)!.loop!.suggestedVerify).toBeNull();
  expect((await post(`/api/tasks/${t.id}/accept-verify`)).status).toBe(409);
});

// A repo space and a task waiting before it starts, whose pre-pass proposed `raw`.
function shaped(raw: unknown, over: Partial<ReturnType<typeof newLoop>> = {}) {
  const repo = tempRepo();
  const s = createSpace(db, { name: "App", kind: "repo", goal: "", repoPath: repo.path });
  const t = createTask(db, { spaceId: s.id, title: "Totals", brief: normalizeBrief({ goal: "Totals", size: "medium" }) });
  setTaskLoop(db, t.id, { ...newLoop(SIZE_BUDGETS.medium), stage: "brief", shape: proposeShape(raw, { size: "medium", checksFound: true }), ...over });
  return { task: getTask(db, t.id)!, repo };
}

const SPLIT = { kind: "split", reason: "two pieces", parts: [{ title: "A", goal: "a", files: ["a.ts"] }, { title: "B", goal: "b", files: ["b.ts"] }] };

test("answers go with the brief, and a shape the pre-pass suggested doesn't hold the task back", async () => {
  const { task, repo } = shaped(SPLIT, { questions: [{ question: "Weekly?", options: [] }] });
  const res = (await (await post(`/api/tasks/${task.id}/answers`, { answers: [{ question: "Weekly?", answer: "Yes" }] })).json()) as { loop: { stage: string; shape: { kind: string; approved: boolean } } };
  // The proposal stays a proposal: answering doesn't approve it.
  expect(res.loop).toMatchObject({ stage: "writing", shape: { kind: "split", approved: false } });
  expect(kicks).toBe(1);
  repo.cleanup();
});

test("the shape override works until the writer starts; after that only a costlier shape, which starts over", async () => {
  const { task, repo } = shaped({ kind: "single" });
  expect((await post(`/api/tasks/${task.id}/shape`, { kind: "split" })).status).toBe(409);
  expect((await post(`/api/tasks/${task.id}/shape`, { kind: "swarm" })).status).toBe(400);
  const res = await post(`/api/tasks/${task.id}/shape`, { kind: "scouts" });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { loop: { shape: { kind: string } } }).loop.shape.kind).toBe("scouts");
  setTaskLoop(db, task.id, { ...getTask(db, task.id)!.loop!, stage: "writing", said: "Did some of it." });
  expect((await post(`/api/tasks/${task.id}/shape`, { kind: "single" })).status).toBe(409);
  // A split suggested while it runs as one writer starts it over from the brief, on the user's click.
  const two = shaped(SPLIT);
  setTaskLoop(db, two.task.id, { ...getTask(db, two.task.id)!.loop!, stage: "writing", said: "Did some of it.", shape: runNow(getTask(db, two.task.id)!.loop!.shape!) });
  const started = (await (await post(`/api/tasks/${two.task.id}/shape`, { kind: "split" })).json()) as { status: string; loop: { said: string | null; shape: { kind: string; approved: boolean } } };
  expect(started).toMatchObject({ status: "queued", loop: { said: null, shape: { kind: "split", approved: true } } });
  repo.cleanup();
  two.repo.cleanup();
});

test("parts and pick refuse a task with nothing waiting", async () => {
  const { task, repo } = shaped({ kind: "single" });
  expect((await post(`/api/tasks/${task.id}/parts`, { action: "merge" })).status).toBe(409);
  expect((await post(`/api/tasks/${task.id}/parts`, { action: "explode" })).status).toBe(400);
  expect((await post(`/api/tasks/${task.id}/pick`, { attempt: "tsk_nope" })).status).toBe(409);
  repo.cleanup();
});

test("a brief-first card's costlier shape runs only when it's the one left chosen", async () => {
  const { repo } = shaped({});
  const s = createSpace(db, { name: "Web", kind: "repo", goal: "", repoPath: repo.path });
  const brief = { goal: "Totals", size: "medium" };
  const plain = (await (await post("/api/command", { spaceId: s.id, text: "totals", brief, shapeDraft: SPLIT })).json()) as { task: { loop: { shape: { kind: string } } } };
  expect(plain.task.loop.shape.kind).toBe("single");
  const chosen = (await (await post("/api/command", { spaceId: s.id, text: "totals", brief, shapeDraft: SPLIT, shape: "split" })).json()) as { task: { loop: { shape: { kind: string; approved: boolean } } } };
  expect(chosen.task.loop.shape).toMatchObject({ kind: "split", approved: true });
  repo.cleanup();
});
