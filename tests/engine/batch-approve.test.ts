import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { approveClean, createApproval, getApproval, listPending, reopenDecision, resolveApproval, UNDO_MS } from "../../src/engine/approvals";
import { openDb } from "../../src/engine/db";
import { newLoop, SIZE_BUDGETS, type LoopState } from "../../src/engine/loop";
import { createSpace } from "../../src/engine/spaces";
import { createTask, getTask, setTaskLoop, setTaskOutcome, setTaskStatus } from "../../src/engine/tasks";
import { tempHome } from "../helpers";

let home: ReturnType<typeof tempHome>;
let db: Database;
beforeEach(() => {
  home = tempHome();
  db = openDb();
});
afterEach(() => {
  db.close();
  home.cleanup();
});

const clean: Partial<LoopState> = { stage: "ready", checks: "passed", reviews: [{ reviewer: "claude", verdict: "approve", findings: [], skipped: null }] };
function result(title: string, loop: Partial<LoopState>) {
  const s = createSpace(db, { name: "Kite", kind: "repo", goal: "g", repoPath: "/tmp/kite-example" });
  const t = createTask(db, { spaceId: s.id, title });
  setTaskStatus(db, t.id, "running");
  setTaskStatus(db, t.id, "review");
  setTaskOutcome(db, t.id, "done", null);
  setTaskLoop(db, t.id, { ...newLoop(SIZE_BUDGETS.small), ...loop });
  return { t, a: createApproval(db, { spaceId: s.id, taskId: t.id, kind: "review", title, detail: "1 commit" }) };
}

test("approves only the clean results it's given and says why it left the rest", () => {
  const ok = result("Clean", clean);
  const noted = result("Noted", { ...clean, attention: ["The change edits check config: bunfig.toml."] });
  const res = approveClean(db, [ok.a.id, noted.a.id, "apr_missing"]);
  expect(res.approved).toEqual([ok.a.id]);
  expect(res.skipped.map((s) => s.id)).toEqual([noted.a.id, "apr_missing"]);
  expect(res.skipped[0]!.reason).toContain("read on its own");
  expect(getTask(db, ok.t.id)!.status).toBe("done");
  expect(listPending(db).map((a) => a.id)).toEqual([noted.a.id]);
});

test("an approval made a moment ago can be reopened for review once", () => {
  const { t, a } = result("Clean", clean);
  resolveApproval(db, a.id, "approve");
  const reopened = reopenDecision(db, a.id);
  expect(reopened.status).toBe("pending");
  expect(reopened.taskId).toBe(t.id);
  expect(getTask(db, t.id)!.status).toBe("review");
  expect(getApproval(db, a.id)!.undoneAt).not.toBeNull();
  expect(() => reopenDecision(db, a.id)).toThrow("already");
});

test("an older approval, a sent-back one, or one whose task moved on stays as it is", () => {
  const late = result("Late", clean);
  resolveApproval(db, late.a.id, "approve");
  expect(() => reopenDecision(db, late.a.id, Date.now() + UNDO_MS + 1)).toThrow("too long ago");
  const back = result("Back", clean);
  resolveApproval(db, back.a.id, "reject");
  expect(() => reopenDecision(db, back.a.id)).toThrow("Only an approval");
  const moved = result("Moved", clean);
  resolveApproval(db, moved.a.id, "approve");
  db.query("UPDATE tasks SET pr_url = 'https://example.com/pr/1' WHERE id = ?").run(moved.t.id);
  expect(() => reopenDecision(db, moved.a.id)).toThrow("pull request");
});
