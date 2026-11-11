import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Server } from "bun";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../../src/engine/db";
import type { DiffResult } from "../../src/engine/diff-parse";
import { gitSettingsFingerprint } from "../../src/engine/git";
import type { SteerOutcome } from "../../src/engine/runner";
import { createSpace } from "../../src/engine/spaces";
import { createTask, getTask, setTaskStatus } from "../../src/engine/tasks";
import { startServer, type WsData } from "../../src/server/server";
import { tempHome, tempRepo } from "../helpers";

let home: ReturnType<typeof tempHome>;
let db: Database;
let server: Server<WsData>;
let base: string;
let steer: { calls: [string, string][]; outcome: SteerOutcome };
const cleanups: Array<() => void> = [];

beforeEach(() => {
  home = tempHome();
  db = openDb();
  steer = { calls: [], outcome: "steered" };
  server = startServer({
    db,
    runner: {
      kick: () => {},
      steerTask: async (id, note) => {
        steer.calls.push([id, note]);
        if (steer.outcome === "steered") setTaskStatus(db, id, "queued");
        return steer.outcome;
      },
    },
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
  while (cleanups.length) cleanups.pop()!();
});

const post = (path: string, body?: unknown, headers: Record<string, string> = { origin: base }) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

function git(path: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-c", "user.name=Atrium Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: path });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
}

function repoTask(title = "Add a footer") {
  const r = tempRepo();
  cleanups.push(r.cleanup);
  const space = createSpace(db, { name: "App", kind: "repo", goal: "g", repoPath: r.path });
  const task = createTask(db, { spaceId: space.id, title });
  return { path: r.path, space, task };
}

const addRun = async (taskId: string, path: string, opts: { fingerprint?: string | null } = {}) =>
  db
    .query("INSERT INTO runs (id, task_id, agent, started_at, transcript_path, start_ref, git_fingerprint) VALUES (?, ?, 'claude', ?, '/tmp/none', 'main', ?)")
    .run(`run_${Math.random().toString(36).slice(2)}`, taskId, Date.now(), opts.fingerprint === undefined ? await gitSettingsFingerprint(path) : opts.fingerprint);

test("diff: a task outside a repo space has none", async () => {
  const s = createSpace(db, { name: "Docs", kind: "general", goal: "g" });
  const t = createTask(db, { spaceId: s.id, title: "Write" });
  expect((await fetch(`${base}/api/tasks/${t.id}/diff`)).status).toBe(404);
  expect((await fetch(`${base}/api/tasks/tsk_nope/diff`)).status).toBe(404);
});

test("diff: a repo task that hasn't run has no changes yet", async () => {
  const { task } = repoTask();
  const res = await fetch(`${base}/api/tasks/${task.id}/diff`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ files: [], totals: { files: 0, additions: 0, deletions: 0 }, truncated: false });
});

test("diff: a running task's uncommitted edits come from the working tree", async () => {
  const { path, task } = repoTask();
  git(path, "checkout", "-b", `atrium/${task.id}`);
  await addRun(task.id, path);
  setTaskStatus(db, task.id, "running", { branch: `atrium/${task.id}` });
  writeFileSync(join(path, "README.md"), "# fixture\nmore\n");
  writeFileSync(join(path, "footer.html"), "<footer></footer>\n");
  const res = await fetch(`${base}/api/tasks/${task.id}/diff`);
  expect(res.status).toBe(200);
  const d = (await res.json()) as DiffResult;
  expect(d.files.map((f) => [f.path, f.status])).toEqual([
    ["README.md", "modified"],
    ["footer.html", "added"],
  ]);
  expect(d.totals).toEqual({ files: 2, additions: 2, deletions: 0 });
});

test("diff: a running task whose repo's git settings changed is refused", async () => {
  const { path, task } = repoTask();
  git(path, "checkout", "-b", `atrium/${task.id}`);
  await addRun(task.id, path);
  setTaskStatus(db, task.id, "running", { branch: `atrium/${task.id}` });
  git(path, "config", "core.editor", "true");
  const res = await fetch(`${base}/api/tasks/${task.id}/diff`);
  expect(res.status).toBe(409);
  expect(await errorOf(res)).toBe("The agent changed this repo's git settings, so Atrium won't read its changes. Atrium checks them when the run ends.");
});

test("diff: a finished task reads its branch; a deleted branch is a plain 404", async () => {
  const { path, task } = repoTask();
  git(path, "checkout", "-b", `atrium/${task.id}`);
  writeFileSync(join(path, "footer.html"), "<footer></footer>\n");
  git(path, "add", "-A");
  git(path, "commit", "-m", "work");
  git(path, "checkout", "main");
  await addRun(task.id, path);
  setTaskStatus(db, task.id, "running", { branch: `atrium/${task.id}` });
  setTaskStatus(db, task.id, "review");
  const res = await fetch(`${base}/api/tasks/${task.id}/diff`);
  expect(res.status).toBe(200);
  expect(((await res.json()) as DiffResult).files.map((f) => f.path)).toEqual(["footer.html"]);
  git(path, "branch", "-D", `atrium/${task.id}`);
  const gone = await fetch(`${base}/api/tasks/${task.id}/diff`);
  expect(gone.status).toBe(404);
  expect(await errorOf(gone)).toBe(`The branch atrium/${task.id} isn't in the repo anymore, so there are no changes to show.`);
});

test("steer: sends the trimmed note and answers 200 once the task is requeued", async () => {
  const { task } = repoTask();
  setTaskStatus(db, task.id, "running");
  const res = await post(`/api/tasks/${task.id}/steer`, { note: "  Use the brand colour  " });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { status: string }).status).toBe("queued");
  expect(steer.calls).toEqual([[task.id, "Use the brand colour"]]);
});

test("steer: 202 while winding down, 409 when it isn't running or finished first", async () => {
  const { task } = repoTask();
  expect((await post(`/api/tasks/${task.id}/steer`, { note: "x" })).status).toBe(409);
  setTaskStatus(db, task.id, "running");
  steer.outcome = "timeout";
  expect((await post(`/api/tasks/${task.id}/steer`, { note: "x" })).status).toBe(202);
  steer.outcome = "not-running";
  const late = await post(`/api/tasks/${task.id}/steer`, { note: "x" });
  expect(late.status).toBe(409);
  expect(await errorOf(late)).toBe("It finished or stopped before your note arrived, so nothing was restarted.");
  expect(getTask(db, task.id)!.status).toBe("running");
});

test("steer: an empty or overlong note is a 400; unknown and non-repo tasks are 404; Origin is required", async () => {
  const { task } = repoTask();
  setTaskStatus(db, task.id, "running");
  const empty = await post(`/api/tasks/${task.id}/steer`, { note: "   " });
  expect(empty.status).toBe(400);
  expect(await errorOf(empty)).toBe("Write a note for the agent first.");
  const long = await post(`/api/tasks/${task.id}/steer`, { note: "x".repeat(2001) });
  expect(long.status).toBe(400);
  expect(await errorOf(long)).toBe("Keep the note to 2,000 characters or fewer.");
  expect((await post(`/api/tasks/${task.id}/steer`, { note: "x".repeat(2000) })).status).toBe(200);
  expect((await post("/api/tasks/tsk_nope/steer", { note: "x" })).status).toBe(404);
  const s = createSpace(db, { name: "Docs", kind: "general", goal: "g" });
  const other = createTask(db, { spaceId: s.id, title: "Write" });
  setTaskStatus(db, other.id, "running");
  expect((await post(`/api/tasks/${other.id}/steer`, { note: "x" })).status).toBe(404);
  expect((await post(`/api/tasks/${task.id}/steer`, { note: "x" }, {})).status).toBe(403);
});
