import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { ALWAYS_ASK, AlreadyResolved, RULE_NEVER_DECIDES, createApproval, getApproval, isOwnYes, listPending, onApprovalResolved, resolveApproval } from "../../src/engine/approvals";
import { openDb } from "../../src/engine/db";
import { listActivity } from "../../src/engine/events";
import { createSpace } from "../../src/engine/spaces";
import { createTask, getTask, InvalidTransition, reopenForReview, setTaskStatus, setTaskOutcome } from "../../src/engine/tasks";
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

test("the always-ask list", () => {
  expect([...ALWAYS_ASK]).toEqual(["merge_main", "deploy", "first_contact", "delete", "spend", "secrets", "create_repo", "push", "remove_clone", "send_message"]);
});

test("a rule never decides a send_message approval", () => {
  const s = createSpace(db, { name: "Messages", kind: "general", goal: "texts" });
  const a = createApproval(db, { spaceId: s.id, kind: "question", title: "Send a text to Dana?", detail: "", alwaysAsk: "send_message" });
  expect(() => resolveApproval(db, a.id, "approve", undefined, { id: "rul_x", label: "x" })).toThrow(RULE_NEVER_DECIDES);
  expect(getApproval(db, a.id)!.status).toBe("pending");
});

function insertRule(spaceId: string, fp = "v1:code:docs:small:claude") {
  db.query("INSERT INTO autonomy_proposals (id, space_id, fingerprint, evidence, status, created_at) VALUES ('prp_1', ?, ?, '[]', 'yes', 1)").run(spaceId, fp);
  db.query("INSERT INTO autonomy_rules (id, space_id, fingerprint, proposal_id, created_at, expires_at) VALUES ('rul_1', ?, ?, 'prp_1', 1, ?)").run(
    spaceId,
    fp,
    Date.now() + 86_400_000,
  );
  return { id: "rul_1", label: "docs changes (Markdown in docs/ or a README/CHANGELOG) up to 50 lines from Claude" };
}

test("a rule approval is recorded as the rule's", () => {
  const { s, t, a } = reviewApproval();
  const rule = insertRule(s.id);
  const r = resolveApproval(db, a.id, "approve", undefined, rule);
  expect(r.decidedBy).toBe("rule");
  expect(r.ruleId).toBe(rule.id);
  expect(getTask(db, t.id)!.status).toBe("done");
  const act = listActivity(db)[0]!;
  expect(act.actor).toBe("atrium");
  expect(act.message.startsWith('Approved by your rule "docs changes')).toBe(true);
  expect(act.message.endsWith(": Review Draft")).toBe(true);
});

test("a rule can't reject", () => {
  const { s, a } = reviewApproval();
  const rule = insertRule(s.id);
  expect(() => resolveApproval(db, a.id, "reject", undefined, rule)).toThrow();
  expect(getApproval(db, a.id)!.status).toBe("pending");
});

test("a manual decision is recorded as yours", () => {
  const { a } = reviewApproval();
  const r = resolveApproval(db, a.id, "approve");
  expect(r.decidedBy).toBe("you");
  expect(r.ruleId).toBeNull();
  expect(r.undoneAt).toBeNull();
});

test("createApproval stores the fingerprint", () => {
  const s = createSpace(db, { name: "Docs", kind: "general", goal: "write" });
  const with_ = createApproval(db, { spaceId: s.id, kind: "question", title: "one", detail: "", fingerprint: "v1:general:text:claude" });
  const without = createApproval(db, { spaceId: s.id, kind: "question", title: "two", detail: "" });
  expect(getApproval(db, with_.id)!.fingerprint).toBe("v1:general:text:claude");
  expect(without.fingerprint).toBeNull();
});

test("reopenForReview only reopens done work tasks", () => {
  const { s, t, a } = reviewApproval();
  resolveApproval(db, a.id, "approve");
  expect(reopenForReview(db, t.id).status).toBe("review");
  const queued = createTask(db, { spaceId: s.id, title: "Queued" });
  expect(() => reopenForReview(db, queued.id)).toThrow(InvalidTransition);
  const review = createTask(db, { spaceId: s.id, title: "Review", kind: "review", parentTaskId: t.id });
  setTaskStatus(db, review.id, "done");
  expect(() => reopenForReview(db, review.id)).toThrow(InvalidTransition);
  expect(getTask(db, review.id)!.status).toBe("done");
});

test("alert approvals resolve without a task", () => {
  const s = createSpace(db, { name: "Stocks", kind: "markets", goal: "watch" });
  const a = createApproval(db, { spaceId: s.id, kind: "alert", title: "AAPL price above $200.00", detail: "d" });
  const seen: string[] = [];
  const offBad = onApprovalResolved(() => {
    throw new Error("listener broke");
  });
  const off = onApprovalResolved((x, decision) => seen.push(`${x.id}:${decision}`));
  const err = console.error;
  console.error = () => {};
  try {
    const r = resolveApproval(db, a.id, "approve");
    expect(r.status).toBe("approved");
  } finally {
    console.error = err;
    off();
    offBad();
  }
  expect(seen).toEqual([`${a.id}:approve`]);
  expect(listActivity(db)[0]!.message).toBe("Dismissed: AAPL price above $200.00");
});

test("topic round-trips", () => {
  const s = createSpace(db, { name: "M", kind: "general", goal: "g" });
  const a = createApproval(db, { spaceId: s.id, kind: "alert", title: "SPY earnings within 5 days", detail: "d", topic: "earnings" });
  expect(getApproval(db, a.id)!.topic).toBe("earnings");
  const b = createApproval(db, { spaceId: s.id, kind: "alert", title: "x", detail: "d" });
  expect(b.topic).toBeNull();
});

test("a spaceless always-ask question waits for Nakul and no rule can decide it", () => {
  const a = createApproval(db, { spaceId: null, kind: "question", title: "Create?", detail: "d", alwaysAsk: "create_repo" });
  expect(a.spaceId).toBeNull();
  expect(a.alwaysAsk).toBe("create_repo");
  expect(listPending(db).map((p) => p.id)).toContain(a.id);
  expect(() => resolveApproval(db, a.id, "approve", undefined, { id: "rul_x", label: "x" })).toThrow("A rule can never decide this. It always waits for you.");
  expect(getApproval(db, a.id)!.status).toBe("pending");
});

test("createApproval refuses an always-ask kind with a fingerprint, or a spaceless non-question", () => {
  const s = createSpace(db, { name: "Docs", kind: "general", goal: "write" });
  expect(() => createApproval(db, { spaceId: s.id, kind: "question", title: "q", detail: "", alwaysAsk: "push", fingerprint: "v1:general:text:claude" })).toThrow();
  expect(() => createApproval(db, { spaceId: null, kind: "review", title: "r", detail: "" })).toThrow();
});

test("isOwnYes is true only for Nakul's own standing approval", () => {
  const mk = () => createApproval(db, { spaceId: null, kind: "question", title: "q", detail: "", alwaysAsk: "create_repo" });
  const pending = mk();
  expect(isOwnYes(pending)).toBe(false);
  const rejected = resolveApproval(db, mk().id, "reject");
  expect(isOwnYes(rejected)).toBe(false);
  const yes = resolveApproval(db, mk().id, "approve");
  expect(isOwnYes(yes)).toBe(true);
  const byRule = mk();
  // As if a rule's decision had slipped past the DB's CHECK: the code must still refuse it.
  db.exec("PRAGMA ignore_check_constraints = ON");
  db.query("UPDATE approvals SET status = 'approved', decided_by = 'rule', resolved_at = 1 WHERE id = ?").run(byRule.id);
  db.exec("PRAGMA ignore_check_constraints = OFF");
  expect(isOwnYes(getApproval(db, byRule.id)!)).toBe(false);
  const undone = resolveApproval(db, mk().id, "approve");
  db.query("UPDATE approvals SET undone_at = 1 WHERE id = ?").run(undone.id);
  expect(isOwnYes(getApproval(db, undone.id)!)).toBe(false);
});

test("accepting a result that wasn't done says so", () => {
  const s = createSpace(db, { name: "Text Dana", kind: "general", goal: "" });
  const accept = (outcome: "couldnt" | "partial") => {
    const t = createTask(db, { spaceId: s.id, title: outcome === "couldnt" ? "Send the text to Dana" : "Write three files" });
    setTaskStatus(db, t.id, "running");
    setTaskStatus(db, t.id, "review");
    setTaskOutcome(db, t.id, outcome, "why");
    const a = createApproval(db, { spaceId: s.id, taskId: t.id, kind: "review", title: t.title, detail: "" });
    resolveApproval(db, a.id, "approve");
    return getTask(db, t.id)!;
  };
  const c = accept("couldnt");
  expect([c.status, c.outcome]).toEqual(["done", "couldnt"]);
  const p = accept("partial");
  const msgs = listActivity(db, { spaceId: s.id }).map((r) => r.message);
  expect(msgs).toContain("Accepted anyway: Send the text to Dana. It says it couldn't do this.");
  expect(msgs).toContain("Accepted as is: Write three files. It says it's only partly done.");
  expect(p.outcome).toBe("partial");
});
