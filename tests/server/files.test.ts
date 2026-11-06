import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Server } from "bun";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApproval, resolveApproval } from "../../src/engine/approvals";
import { openDb } from "../../src/engine/db";
import { spaceFolder } from "../../src/engine/folders";
import { recordRunFiles } from "../../src/engine/outputs/store";
import { createSpace, type Space } from "../../src/engine/spaces";
import { createTask, setTaskStatus } from "../../src/engine/tasks";
import { startServer, type WsData } from "../../src/server/server";
import { tempHome, tempRepo } from "../helpers";

let home: ReturnType<typeof tempHome>;
let db: Database;
let server: Server<WsData>;
let base: string;
let log: string;
const cleanups: Array<() => void> = [];

beforeEach(() => {
  home = tempHome();
  db = openDb();
  log = join(home.home, "open.log");
  process.env.FAKE_OPEN_LOG = log;
  server = startServer({ db, runner: { kick() {} }, setup: async () => { throw new Error("no"); }, port: 0 });
  base = `http://127.0.0.1:${server.port}`;
});
afterEach(() => {
  server.stop(true);
  db.close();
  delete process.env.FAKE_OPEN_LOG;
  home.cleanup();
  while (cleanups.length) cleanups.pop()!();
});

const get = (path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers });
const post = (path: string, body: unknown, headers: Record<string, string> = { origin: base }) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const getTaskSpace = (taskId: string) => (db.query("SELECT space_id FROM tasks WHERE id = ?").get(taskId) as { space_id: string }).space_id;
const logged = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

let runN = 0;
function made(space: Space, title: string, files: Record<string, string>, opts: { summary?: string } = {}) {
  const folder = spaceFolder(space);
  mkdirSync(folder, { recursive: true });
  const task = createTask(db, { spaceId: space.id, title });
  const runId = `run_${++runN}`;
  db.query("INSERT INTO runs (id, task_id, agent, started_at, transcript_path) VALUES (?, ?, 'claude', ?, '')").run(runId, task.id, Date.now());
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(folder, p, ".."), { recursive: true });
    writeFileSync(join(folder, p), body);
  }
  recordRunFiles(db, { runId, taskId: task.id, spaceId: space.id, root: "space" }, Object.entries(files).map(([path, b]) => ({ path, change: "created" as const, size: b.length })));
  setTaskStatus(db, task.id, "running");
  setTaskStatus(db, task.id, "review");
  const approval = createApproval(db, { spaceId: space.id, taskId: task.id, kind: "review", title, detail: opts.summary ?? "**Done.** Made the list." });
  return { task, approval, folder };
}

test("outputs show the summary and files after approval", async () => {
  const s = createSpace(db, { name: "Weekly Planning", kind: "general", goal: "" });
  const { task, approval, folder } = made(s, "Groceries", { "grocery-list.md": "- milk\n", "week.ics": "BEGIN:VCALENDAR\n" });
  resolveApproval(db, approval.id, "approve");
  const out = await (await get(`/api/tasks/${task.id}/outputs`)).json();
  expect(out.summary).toMatchObject({ text: "**Done.** Made the list.", status: "approved", decidedBy: "you" });
  expect(out.files.map((f: { path: string; exists: boolean; kind: string }) => [f.path, f.exists, f.kind]).sort()).toEqual([
    ["grocery-list.md", true, "markdown"],
    ["week.ics", true, "calendar"],
  ]);
  expect(out.files[0].absPath.startsWith(folder)).toBe(true);
  rmSync(join(folder, "week.ics"));
  const again = await (await get(`/api/tasks/${task.id}/outputs`)).json();
  expect(again.files.find((f: { path: string }) => f.path === "week.ics").exists).toBe(false);
  expect((await get("/api/tasks/nope/outputs")).status).toBe(404);
});

test("space files list newest first and credit the newest task", async () => {
  const s = createSpace(db, { name: "Weekly Planning", kind: "general", goal: "" });
  made(s, "Groceries", { "grocery-list.md": "- milk\n" });
  await Bun.sleep(15);
  const later = made(s, "Edit list", { "grocery-list.md": "- milk\n- eggs\n" });
  await Bun.sleep(15);
  writeFileSync(join(spaceFolder(s), "mine.txt"), "mine");
  mkdirSync(join(spaceFolder(s), ".claude"), { recursive: true });
  const out = await (await get(`/api/spaces/${s.id}/files`)).json();
  expect(out.folder).toBe(spaceFolder(s));
  expect(out.files.map((f: { path: string }) => f.path)).toEqual(["mine.txt", "grocery-list.md"]);
  expect(out.files[1].madeBy).toEqual({ taskId: later.task.id, title: "Edit list" });
  expect(out.files[0].madeBy).toBeNull();
  expect(out.truncated).toBe(false);
});

test("preview and raw read inside the folder only", async () => {
  const s = createSpace(db, { name: "Weekly Planning", kind: "general", goal: "" });
  const { folder } = made(s, "Groceries", { "grocery-list.md": "- milk\n", "chart.png": "\x89PNG" });
  const ok = await (await get(`/api/spaces/${s.id}/file?path=grocery-list.md`)).json();
  expect(ok).toMatchObject({ path: "grocery-list.md", kind: "markdown", text: "- milk\n", truncated: false });
  for (const bad of ["../atrium.db", "%2Fetc%2Fhosts", ".claude%2Fx"]) {
    const r = await get(`/api/spaces/${s.id}/file?path=${bad}`);
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("That isn't a file Atrium can show.");
  }
  symlinkSync("/etc/hosts", join(folder, "secret.md"));
  const link = await get(`/api/spaces/${s.id}/file?path=secret.md`);
  expect(link.status).toBe(403);
  expect((await link.json()).error).toBe("This file points outside the space folder, so Atrium won't open it.");
  const raw = await get(`/api/spaces/${s.id}/file/raw?path=chart.png`);
  expect(raw.status).toBe(200);
  expect(raw.headers.get("content-type")).toBe("image/png");
  expect(raw.headers.get("x-content-type-options")).toBe("nosniff");
  expect(raw.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
  expect(raw.headers.get("cache-control")).toBe("no-store");
  expect((await get(`/api/spaces/nope/file?path=a.md`)).status).toBe(404);
});

test("open needs our Origin", async () => {
  const s = createSpace(db, { name: "Weekly Planning", kind: "general", goal: "" });
  const { folder } = made(s, "Groceries", { "grocery-list.md": "- milk\n" });
  expect((await post(`/api/spaces/${s.id}/file/open`, { path: "grocery-list.md", how: "open" }, {})).status).toBe(403);
  expect(logged()).toEqual([]);
  const opened = await post(`/api/spaces/${s.id}/file/open`, { path: "grocery-list.md", how: "open" });
  expect(await opened.json()).toEqual({ ok: true, app: "TextEdit", copy: true });
  const [flag, app, copy] = (logged() as string[][])[0]!;
  expect([flag, app]).toEqual(["-a", "TextEdit"]);
  // A private copy, never the agent's file itself.
  expect(copy!.startsWith(realpathSync(folder))).toBe(false);
  expect(readFileSync(copy!, "utf8")).toBe("- milk\n");
  const foreign = await fetch(base + `/api/spaces/${s.id}/file/open`, {
    method: "POST",
    headers: { host: "evil.example", origin: base, "content-type": "application/json" },
    body: JSON.stringify({ path: "grocery-list.md", how: "open" }),
  });
  expect(foreign.status).toBe(403);
  expect((await get(`/api/spaces/${s.id}/file?path=grocery-list.md`, { "sec-fetch-site": "cross-site" })).status).toBe(403);
  expect((await post(`/api/spaces/${s.id}/file/open`, { path: "grocery-list.md", how: "launch" })).status).toBe(400);
});

test("the folder itself can be revealed but not opened", async () => {
  const s = createSpace(db, { name: "Weekly Planning", kind: "general", goal: "" });
  const { folder } = made(s, "Groceries", { "grocery-list.md": "- milk\n" });
  expect((await post(`/api/spaces/${s.id}/file/open`, { path: ".", how: "reveal" })).status).toBe(200);
  expect(logged()).toEqual([["-R", realpathSync(folder)]]);
  expect((await post(`/api/spaces/${s.id}/file/open`, { path: ".", how: "open" })).status).toBe(400);
});

function repoSpaceWithBranch() {
  const r = tempRepo();
  cleanups.push(r.cleanup);
  const git = (...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: r.path });
  const s = createSpace(db, { name: "App", kind: "repo", goal: "", repoPath: r.path });
  const task = createTask(db, { spaceId: s.id, title: "Add docs" });
  const branch = `atrium/${task.id}`;
  git("checkout", "-b", branch);
  mkdirSync(join(r.path, "docs"));
  writeFileSync(join(r.path, "docs", "a.md"), "# On the branch\n");
  git("add", "-A");
  git("commit", "-m", "docs");
  git("checkout", "main");
  setTaskStatus(db, task.id, "running", { branch });
  db.query("INSERT INTO runs (id, task_id, agent, started_at, transcript_path) VALUES ('run_r', ?, 'claude', ?, '')").run(task.id, Date.now());
  recordRunFiles(db, { runId: "run_r", taskId: task.id, spaceId: s.id, root: "branch", ref: branch }, [{ path: "docs/a.md", change: "created", size: null, insertions: 1, deletions: 0 }]);
  return { s, task, repo: r.path };
}

test("repo spaces reveal only", async () => {
  const { s, repo } = repoSpaceWithBranch();
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  const open = await post(`/api/spaces/${s.id}/file/open`, { path: "README.md", how: "open" });
  expect(open.status).toBe(409);
  expect((await open.json()).error).toBe(
    "This file's latest version is on its task branch, not in your working copy. Check out the branch to open it, or use the preview here.",
  );
  expect((await post(`/api/spaces/${s.id}/file/open`, { path: "README.md", how: "reveal" })).status).toBe(200);
  expect(logged()).toEqual([["-R", join(realpathSync(repo), "README.md")]]);
  const onlyOnBranch = await post(`/api/spaces/${s.id}/file/open`, { path: "docs/a.md", how: "reveal" });
  expect(onlyOnBranch.status).toBe(404);
  expect((await onlyOnBranch.json()).error).toBe("This file is only on its task branch so far, so Finder can't show it. Check out the branch to see it.");
  const files = await (await get(`/api/spaces/${s.id}/files`)).json();
  expect(files.folder).toBe(repo);
  expect(files.files.map((f: { path: string; root: string }) => [f.path, f.root])).toEqual([["docs/a.md", "branch"]]);
});

test("branch preview reads from the task branch", async () => {
  const { task } = repoSpaceWithBranch();
  const p = await (await get(`/api/tasks/${task.id}/file?path=docs%2Fa.md`)).json();
  expect(p.text).toBe("# On the branch\n");
  const out = await (await get(`/api/tasks/${task.id}/outputs`)).json();
  expect(out.files[0]).toMatchObject({ root: "branch", path: "docs/a.md", exists: true, insertions: 1 });
  const plain = createTask(db, { spaceId: createSpace(db, { name: "G", kind: "general", goal: "" }).id, title: "x" });
  const none = await get(`/api/tasks/${plain.id}/file?path=a.md`);
  expect(none.status).toBe(404);
  expect((await none.json()).error).toBe("This task has no branch to read from.");
});

test("branch files are checked against the branch with one git call, and a file a later commit deleted reads as gone", async () => {
  const { task, repo } = repoSpaceWithBranch();
  const git = (...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: repo });
  git("checkout", `atrium/${task.id}`);
  git("rm", "-q", "docs/a.md");
  git("commit", "-qm", "drop");
  git("checkout", "main");
  recordRunFiles(db, { runId: "run_r", taskId: task.id, spaceId: getTaskSpace(task.id), root: "branch", ref: `atrium/${task.id}` }, [
    { path: "README.md", change: "changed", size: null },
    { path: "docs/b.md", change: "created", size: null },
  ]);
  const spawn = spyOn(Bun, "spawn");
  try {
    const out = await (await get(`/api/tasks/${task.id}/outputs`)).json();
    const byPath = Object.fromEntries(out.files.map((f: { path: string; exists: boolean }) => [f.path, f.exists]));
    expect(byPath).toEqual({ "docs/a.md": false, "README.md": true, "docs/b.md": false });
    const gitCalls = spawn.mock.calls.filter((c) => Array.isArray(c[0]) && c[0][0] === "git");
    expect(gitCalls.length).toBeLessThanOrEqual(1);
  } finally {
    spawn.mockRestore();
  }
});
