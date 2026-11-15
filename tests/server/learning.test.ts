import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Server } from "bun";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Registry } from "../../src/engine/agents/registry";
import type { AgentAdapter, AgentRunInput } from "../../src/engine/agents/types";
import { openDb } from "../../src/engine/db";
import { newLoop, SIZE_BUDGETS } from "../../src/engine/loop";
import { openLines } from "../../src/engine/memory";
import { createSpace, getSpace } from "../../src/engine/spaces";
import { createTask, getTask, setTaskLoop, setTaskStatus } from "../../src/engine/tasks";
import { startServer, type WsData } from "../../src/server/server";
import { tempHome, tempRepo } from "../helpers";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "learning");
const NOTE = readFileSync(join(FIXTURES, "hunk-note.txt"), "utf8").trim();
const REVIEW = readFileSync(join(FIXTURES, "review-deep.txt"), "utf8").replaceAll("src/cart.ts", "cart.ts");

let home: ReturnType<typeof tempHome>;
let db: Database;
let server: Server<WsData>;
let base: string;
let repo: ReturnType<typeof tempRepo>;
const calls: AgentRunInput[] = [];

const claude: AgentAdapter = {
  id: "claude",
  label: "Claude Code",
  async run(input) {
    calls.push(input);
    const text = input.systemPrompt.startsWith("You explain a finished") ? REVIEW : NOTE;
    return { status: "ok", summary: text, inputTokens: 1, outputTokens: 1 };
  },
};

const git = (...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd: repo.path });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};

beforeEach(() => {
  home = tempHome();
  db = openDb();
  calls.length = 0;
  repo = tempRepo();
  server = startServer({
    db,
    runner: { kick() {}, registry: { adapters: { claude } } as unknown as Registry },
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
  repo.cleanup();
  home.cleanup();
});

const send = (method: string, path: string, body: unknown = {}) =>
  fetch(base + path, { method, headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify(body) });

// A finished task whose branch changed cart.ts, with the run that says where it started.
function finished(learning: "light" | "deep" = "deep") {
  git("checkout", "-qb", "atrium/tsk_cart");
  writeFileSync(join(repo.path, "cart.ts"), "export const total = (n: number) => n;\nexport const zero = 0;\n");
  git("add", "-A");
  git("commit", "-qm", "cart");
  git("checkout", "-q", "main");
  const s = createSpace(db, { name: "Cart", kind: "repo", goal: "", repoPath: repo.path });
  db.query("UPDATE spaces SET learning = ? WHERE id = ?").run(learning, s.id);
  const t = createTask(db, { spaceId: s.id, title: "Cart" });
  db.query("UPDATE tasks SET branch = 'atrium/tsk_cart' WHERE id = ?").run(t.id);
  db.query("INSERT INTO runs (id, task_id, agent, started_at, ended_at, transcript_path, start_ref) VALUES ('run_1', ?, 'claude', 1, 2, '/nowhere', 'main')").run(t.id);
  setTaskLoop(db, t.id, { ...newLoop(SIZE_BUDGETS.small), stage: "ready", checkedSha: git("rev-parse", "atrium/tsk_cart") });
  setTaskStatus(db, t.id, "review");
  return { space: getSpace(db, s.id)!, task: getTask(db, t.id)! };
}

test("the learning dial is set per space and checked", async () => {
  const s = createSpace(db, { name: "App", kind: "repo", goal: "", repoPath: repo.path });
  expect(getSpace(db, s.id)!.learning).toBe("light");
  expect((await send("PATCH", `/api/spaces/${s.id}`, { learning: "deep" })).status).toBe(200);
  expect(getSpace(db, s.id)!.learning).toBe("deep");
  const bad = await send("PATCH", `/api/spaces/${s.id}`, { learning: "max" });
  expect([bad.status, ((await bad.json()) as { error: string }).error]).toEqual([400, "learning must be off, light or deep."]);
});

test("a walkthrough is written on request, its question answered or skipped, and an unfinished task has none", async () => {
  const { task } = finished();
  const res = await send("POST", `/api/tasks/${task.id}/walkthrough`);
  expect(res.status).toBe(200);
  const w = getTask(db, task.id)!.loop!.walkthrough!;
  expect(w.predict).not.toBeNull();
  expect(calls[0]).toMatchObject({ allowedTools: [], model: "haiku" });
  // Fresh now, so asking again runs nothing.
  await send("POST", `/api/tasks/${task.id}/walkthrough`);
  expect(calls).toHaveLength(1);
  expect((await send("POST", `/api/tasks/${task.id}/predict`, { guess: "b" })).status).toBe(400);
  expect((await send("POST", `/api/tasks/${task.id}/predict`, { guess: 2 })).status).toBe(200);
  expect(getTask(db, task.id)!.loop!.walkthrough!.predict!.guess).toBe(2);
  const other = createTask(db, { spaceId: task.spaceId, title: "Not yet" });
  expect((await send("POST", `/api/tasks/${other.id}/walkthrough`)).status).toBe(409);
});

test("a hunk is explained from the task's own diff, once, and a hunk that moved on is refused", async () => {
  const { task } = finished("light");
  const diff = (await (await fetch(`${base}/api/tasks/${task.id}/diff`)).json()) as { files: { path: string; hunks: { header: string }[] }[] };
  const header = diff.files[0]!.hunks[0]!.header;
  const first = await send("POST", `/api/tasks/${task.id}/explain-hunk`, { file: "cart.ts", header });
  expect(await first.json()).toEqual({ note: NOTE, cached: false });
  expect(calls[0]).toMatchObject({ allowedTools: ["Read", "Glob", "Grep"], cwd: repo.path });
  expect(calls[0]!.prompt).toContain("+export const zero = 0;");
  expect(await (await send("POST", `/api/tasks/${task.id}/explain-hunk`, { file: "cart.ts", header })).json()).toEqual({ note: NOTE, cached: true });
  expect(calls).toHaveLength(1);
  expect((await send("POST", `/api/tasks/${task.id}/explain-hunk`, { file: "cart.ts", header: "@@ -9 +9 @@" })).status).toBe(409);
  expect((await send("POST", `/api/tasks/${task.id}/explain-hunk`, { file: "cart.ts" })).status).toBe(400);
});

test("CLAUDE.md's size is reported, and a proposal is accepted with the user's text or dismissed", async () => {
  const { space, task } = finished("light");
  expect(await (await fetch(`${base}/api/spaces/${space.id}/memory`)).json()).toEqual({ lines: 0, budget: 200, missing: true, problem: null });
  db.query("INSERT INTO memory_lines (id, space_id, task_id, source, line, created_at) VALUES ('mem_a', ?, ?, 'steer', 'Use cents.', 1), ('mem_b', ?, NULL, 'review', 'Other.', 1)").run(space.id, task.id, space.id);
  expect(openLines(db).map((m) => m.id)).toEqual(["mem_a", "mem_b"]);
  // Hidden characters in the edited line are refused before anything is committed.
  const hidden = await send("POST", "/api/memory/mem_a", { action: "accept", line: "Money is cents.\u{E0069}\u{E0067}" });
  expect([hidden.status, ((await hidden.json()) as { error: string }).error]).toEqual([409, "Keep it to one line of plain text, 300 characters or fewer, with no hidden characters."]);
  const accepted = await send("POST", "/api/memory/mem_a", { action: "accept", line: "Money is integer cents." });
  expect(await accepted.json()).toMatchObject({ status: "accepted", branch: "atrium/tsk_cart" });
  expect(git("show", "atrium/tsk_cart:CLAUDE.md")).toBe("## Notes from Atrium\n\n- Money is integer cents.");
  expect((await send("POST", "/api/memory/mem_a", { action: "accept", line: "x" })).status).toBe(409);
  // With learning off, a proposal can't be accepted even by a direct request; the UI hides it anyway.
  db.query("INSERT INTO memory_lines (id, space_id, task_id, source, line, created_at) VALUES ('mem_c', ?, NULL, 'steer', 'Off.', 1)").run(space.id);
  db.query("UPDATE spaces SET learning = 'off' WHERE id = ?").run(space.id);
  const off = await send("POST", "/api/memory/mem_c", { action: "accept", line: "Off." });
  expect([off.status, ((await off.json()) as { error: string }).error]).toEqual([409, "Learning is off for this space, so Atrium adds no CLAUDE.md lines here. Turn it on in the space's settings first."]);
  db.query("UPDATE spaces SET learning = 'light' WHERE id = ?").run(space.id);
  expect(await (await send("POST", "/api/memory/mem_b", { action: "dismiss" })).json()).toMatchObject({ status: "dismissed" });
  expect((await send("POST", "/api/memory/mem_b", { action: "maybe" })).status).toBe(400);
});
