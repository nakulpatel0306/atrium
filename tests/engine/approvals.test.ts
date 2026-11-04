import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { ALWAYS_ASK, AlreadyResolved, createApproval, listPending, requiresApproval, resolveApproval } from "../../src/engine/approvals";
import { openDb } from "../../src/engine/db";
import { listActivity } from "../../src/engine/events";
import { createSpace } from "../../src/engine/spaces";
import { createTask, getTask, setTaskStatus } from "../../src/engine/tasks";
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

function reviewApproval() {
  const s = createSpace(db, { name: "Docs", kind: "general", goal: "write" });
  const t = createTask(db, { spaceId: s.id, title: "Draft", detail: "Write it." });
  setTaskStatus(db, t.id, "running");
  setTaskStatus(db, t.id, "review");
  const a = createApproval(db, { spaceId: s.id, taskId: t.id, kind: "review", title: "Review Draft", detail: "diff" });
  return { s, t, a };
}

test("approving a review marks the task done", () => {
  const { t, a } = reviewApproval();
  const r = resolveApproval(db, a.id, "approve");
  expect(r.status).toBe("approved");
  expect(r.resolvedAt).not.toBeNull();
  expect(getTask(db, t.id)!.status).toBe("done");
  expect(listPending(db)).toHaveLength(0);
  expect(listActivity(db)[0]!.actor).toBe("you");
});

test("rejecting a review requeues the task with feedback appended", () => {
  const { t, a } = reviewApproval();
  const r = resolveApproval(db, a.id, "reject", "tighten tests");
  expect(r.status).toBe("rejected");
  expect(r.note).toBe("tighten tests");
  const task = getTask(db, t.id)!;
  expect(task.status).toBe("queued");
  expect(task.detail).toContain("Feedback: tighten tests");
  expect(task.detail.startsWith("Write it.")).toBe(true);
});

test("resolving twice throws AlreadyResolved", () => {
  const { a } = reviewApproval();
  resolveApproval(db, a.id, "approve");
  expect(() => resolveApproval(db, a.id, "reject", "late")).toThrow(AlreadyResolved);
});

test("listPending returns newest first", () => {
  const s = createSpace(db, { name: "Docs", kind: "general", goal: "write" });
  const first = createApproval(db, { spaceId: s.id, kind: "question", title: "one", detail: "" });
  const second = createApproval(db, { spaceId: s.id, kind: "question", title: "two", detail: "" });
  expect(listPending(db).map((a) => a.id)).toEqual([second.id, first.id]);
});

test("ALWAYS_ASK actions always require approval", () => {
  for (const action of ALWAYS_ASK) expect(requiresApproval(action)).toBe(true);
});
