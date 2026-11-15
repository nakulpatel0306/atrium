import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Server } from "bun";
import { createApproval, listPending } from "../../src/engine/approvals";
import { openDb } from "../../src/engine/db";
import { newLoop, SIZE_BUDGETS, type LoopState } from "../../src/engine/loop";
import { createSpace } from "../../src/engine/spaces";
import { createTask, getTask, setTaskLoop, setTaskOutcome, setTaskStatus } from "../../src/engine/tasks";
import { startServer, type WsData } from "../../src/server/server";
import { tempHome } from "../helpers";

let home: ReturnType<typeof tempHome>;
let db: Database;
let server: Server<WsData>;
let base: string;
beforeEach(() => {
  home = tempHome();
  db = openDb();
  server = startServer({ db, runner: { kick() {} }, setup: async () => Promise.reject(new Error("not stubbed")), port: 0 });
  base = `http://127.0.0.1:${server.port}`;
});
afterEach(() => {
  server.stop(true);
  db.close();
  home.cleanup();
});
const post = (path: string, body?: unknown) => fetch(base + path, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

const clean: Partial<LoopState> = { stage: "ready", checks: "passed", reviews: [{ reviewer: "claude", verdict: "approve", findings: [], skipped: null }] };
function result(title: string, loop: Partial<LoopState>) {
  const s = createSpace(db, { name: "Kite", kind: "repo", goal: "g", repoPath: "/tmp/kite-example" });
  const t = createTask(db, { spaceId: s.id, title });
  setTaskStatus(db, t.id, "running");
  setTaskStatus(db, t.id, "review");
  setTaskOutcome(db, t.id, "done", null);
  setTaskLoop(db, t.id, { ...newLoop(SIZE_BUDGETS.small), ...loop });
  return { t, a: createApproval(db, { spaceId: s.id, taskId: t.id, kind: "review", title, detail: "" }) };
}

test("batch approval takes only clean results, whatever the page asked for", async () => {
  const ok = result("Clean", clean);
  const failing = result("Failing", { ...clean, checks: "failed" });
  const res = await post("/api/approvals/batch", { ids: [ok.a.id, failing.a.id] });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { approved: string[]; skipped: { id: string }[] };
  expect(body.approved).toEqual([ok.a.id]);
  expect(body.skipped.map((s) => s.id)).toEqual([failing.a.id]);
  expect(listPending(db).map((a) => a.id)).toEqual([failing.a.id]);
  expect((await post("/api/approvals/batch", { ids: "all" })).status).toBe(400);
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
