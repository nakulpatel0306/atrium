import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Server } from "bun";
import { createApproval, listPending } from "../../src/engine/approvals";
import { openDb } from "../../src/engine/db";
import { newLoop, SIZE_BUDGETS, type LoopState } from "../../src/engine/loop";
import { createSpace } from "../../src/engine/spaces";
import { createTask, getTask, setTaskLoop, setTaskOutcome, setTaskStatus } from "../../src/engine/tasks";
import { startServer, type WsData } from "../../src/server/server";
import { branchAt, tempHome, tempRepo } from "../helpers";

let home: ReturnType<typeof tempHome>;
let db: Database;
let server: Server<WsData>;
let base: string;
let repo: ReturnType<typeof tempRepo>;
beforeEach(() => {
  home = tempHome();
  repo = tempRepo();
  db = openDb();
  server = startServer({ db, runner: { kick() {} }, setup: async () => Promise.reject(new Error("not stubbed")), port: 0 });
  base = `http://127.0.0.1:${server.port}`;
});
afterEach(() => {
  server.stop(true);
  db.close();
  repo.cleanup();
  home.cleanup();
});
const post = (path: string, body?: unknown) => fetch(base + path, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

const clean: Partial<LoopState> = { stage: "ready", checks: "passed", reviews: [{ reviewer: "claude", verdict: "approve", findings: [], skipped: null }] };
function result(title: string, loop: Partial<LoopState>) {
  const s = createSpace(db, { name: "Kite", kind: "repo", goal: "g", repoPath: repo.path });
  const t = createTask(db, { spaceId: s.id, title });
  const sha = branchAt(repo.path, `atrium/${t.id}`);
  setTaskStatus(db, t.id, "running", { branch: `atrium/${t.id}` });
  setTaskStatus(db, t.id, "review");
  setTaskOutcome(db, t.id, "done", null);
  setTaskLoop(db, t.id, { ...newLoop(SIZE_BUDGETS.small), checkedSha: sha, reviewedSha: sha, ...loop });
  return { t, sha, a: createApproval(db, { spaceId: s.id, taskId: t.id, kind: "review", title, detail: "" }) };
}

test("batch approval takes only clean results, whatever the page asked for", async () => {
  const ok = result("Clean", clean);
  const failing = result("Failing", { ...clean, checks: "failed" });
  const res = await post("/api/approvals/batch", { items: [{ id: ok.a.id, sha: ok.sha }, { id: failing.a.id, sha: failing.sha }] });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { approved: string[]; skipped: { id: string }[] };
  expect(body.approved).toEqual([ok.a.id]);
  expect(body.skipped.map((s) => s.id)).toEqual([failing.a.id]);
  expect(listPending(db).map((a) => a.id)).toEqual([failing.a.id]);
  expect((await post("/api/approvals/batch", { ids: [ok.a.id] })).status).toBe(400);
  expect((await post("/api/approvals/batch", { items: [{ id: ok.a.id }] })).status).toBe(400);
});

test("approving names the commit shown; a branch that moved since is refused in plain words", async () => {
  const { a } = result("Moved", clean);
  const res = await post(`/api/approvals/${a.id}`, { decision: "approve", sha: "0".repeat(40) });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toContain("changed since you looked");
  expect(listPending(db).map((x) => x.id)).toContain(a.id);
});

test("a just-given approval can be taken back from the toast", async () => {
  const { t, a } = result("Clean", clean);
  expect((await post(`/api/approvals/${a.id}`, { decision: "approve" })).status).toBe(200);
  const res = await post(`/api/approvals/${a.id}/reopen`);
  expect(res.status).toBe(200);
  expect(getTask(db, t.id)!.status).toBe("review");
  const again = await post(`/api/approvals/${a.id}/reopen`);
  expect(again.status).toBe(409);
  expect(((await again.json()) as { error: string }).error).toContain("already");
});
