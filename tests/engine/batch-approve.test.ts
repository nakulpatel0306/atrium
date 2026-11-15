import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { approveClean, createApproval, getApproval, listPending, reopenDecision, resolveApproval, UNDO_MS } from "../../src/engine/approvals";
import { openDb } from "../../src/engine/db";
import { newLoop, SIZE_BUDGETS, type LoopState } from "../../src/engine/loop";
import { createSpace } from "../../src/engine/spaces";
import { createTask, getTask, setTaskLoop, setTaskOutcome, setTaskStatus } from "../../src/engine/tasks";
import { branchAt, tempHome, tempRepo } from "../helpers";

let home: ReturnType<typeof tempHome>;
let repo: ReturnType<typeof tempRepo>;
let db: Database;
beforeEach(() => {
  home = tempHome();
  repo = tempRepo();
  db = openDb();
});
afterEach(() => {
  db.close();
  repo.cleanup();
  home.cleanup();
});

const clean: Partial<LoopState> = { stage: "ready", checks: "passed", reviews: [{ reviewer: "claude", verdict: "approve", findings: [], skipped: null }] };
// A finished result on its own branch, checked and reviewed at the branch's head.
function result(title: string, loop: Partial<LoopState>) {
  const s = createSpace(db, { name: "Kite", kind: "repo", goal: "g", repoPath: repo.path });
  const t = createTask(db, { spaceId: s.id, title });
  const sha = branchAt(repo.path, `atrium/${t.id}`);
  setTaskStatus(db, t.id, "running", { branch: `atrium/${t.id}` });
  setTaskStatus(db, t.id, "review");
  setTaskOutcome(db, t.id, "done", null);
  setTaskLoop(db, t.id, { ...newLoop(SIZE_BUDGETS.small), checkedSha: sha, reviewedSha: sha, headSha: sha, ...loop });
  return { t, sha, a: createApproval(db, { spaceId: s.id, taskId: t.id, kind: "review", title, detail: "1 commit" }) };
}

test("approves only the clean results it's given, at the commit shown, and says why it left the rest", () => {
  const ok = result("Clean", clean);
  const noted = result("Noted", { ...clean, attention: ["The change edits check config: bunfig.toml."] });
  const res = approveClean(db, [{ id: ok.a.id, sha: ok.sha }, { id: noted.a.id, sha: noted.sha }, { id: "apr_missing", sha: ok.sha }]);
  expect(res.approved).toEqual([ok.a.id]);
  expect(res.skipped.map((s) => s.id)).toEqual([noted.a.id, "apr_missing"]);
  expect(res.skipped[0]!.reason).toContain("read on its own");
  expect(res.skipped[1]!.reason).toBe("No such approval.");
  expect(getTask(db, ok.t.id)!.status).toBe("done");
  expect(listPending(db).map((a) => a.id)).toEqual([noted.a.id]);
});

test("a result whose branch moved since it was shown, checked or reviewed is left for another look", () => {
  const shown = result("Moved", clean);
  // Something committed to the branch after the review (a CLAUDE.md line, say).
  Bun.spawnSync(["git", "commit", "--allow-empty", "-q", "-m", "later", "--no-verify"], { cwd: repo.path, env: { ...process.env, GIT_DIR: `${repo.path}/.git` } });
  const head = branchAt(repo.path, `atrium/${shown.t.id}`);
  const stale = approveClean(db, [{ id: shown.a.id, sha: shown.sha }]);
  expect(stale.approved).toEqual([]);
  expect(stale.skipped[0]!.reason).toContain("changed since");
  // Even naming the new head doesn't do: the checks and review read the old one.
  expect(approveClean(db, [{ id: shown.a.id, sha: head }]).approved).toEqual([]);
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
  expect(() => reopenDecision(db, moved.a.id)).toThrow("left your Mac");
});

test("once a push or pull request has started for the result, it can't be taken back", () => {
  const { t, a } = result("Pushed", clean);
  resolveApproval(db, a.id, "approve");
  createApproval(db, { spaceId: getTask(db, t.id)!.spaceId, taskId: t.id, kind: "question", title: "Push and open a pull request?", detail: "", alwaysAsk: "push" });
  expect(() => reopenDecision(db, a.id)).toThrow("left your Mac");
});
