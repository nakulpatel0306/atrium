import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { type Approval, createApproval, resolveApproval } from "../../src/engine/approvals";
import { RULE_TTL_MS } from "../../src/engine/autonomy/kinds";
import {
  answerProposal,
  cleanStreak,
  considerProposal,
  listNeverProposals,
  listPendingProposals,
  suggestAgain,
} from "../../src/engine/autonomy/proposals";
import { applyRule, revokeRule, RuleRefused } from "../../src/engine/autonomy/rules";
import { openDb } from "../../src/engine/db";
import { createSpace, type Space } from "../../src/engine/spaces";
import { createTask, setTaskOutcome, setTaskStatus, type Task } from "../../src/engine/tasks";
import { branchAt, PLAIN_DOCS, tempHome, tempRepo } from "../helpers";

const FP = "v1:code:docs:small:claude";
let home: ReturnType<typeof tempHome>;
let db: Database;
let space: Space;
let repo: ReturnType<typeof tempRepo>;
// A clock a day in the past that moves a second per step, so ordering never depends on two things landing in
// different milliseconds.
let clock: number;
const tick = () => (clock += 1000);

beforeEach(() => {
  home = tempHome();
  db = openDb();
  repo = tempRepo();
  space = createSpace(db, { name: "Docs", kind: "repo", goal: "write", repoPath: repo.path });
  clock = Date.now() - 86_400_000;
});
afterEach(() => {
  db.close();
  home.cleanup();
  repo.cleanup();
});

function reviewTask(s: Space, title = "Add a note"): Task {
  const t = createTask(db, { spaceId: s.id, title });
  setTaskStatus(db, t.id, "running");
  setTaskStatus(db, t.id, "review", { branch: `atrium/${t.id}` });
  return setTaskOutcome(db, t.id, "done", null);
}

function decide(a: Approval, decision: "approve" | "reject", note?: string, at = tick()): Approval {
  const r = resolveApproval(db, a.id, decision, note);
  db.query("UPDATE approvals SET resolved_at = ? WHERE id = ?").run(at, a.id);
  return r;
}

function approveClean(s: Space = space, fp: string | null = FP, opts: { title?: string; detail?: string; at?: number } = {}): Approval {
  const t = reviewTask(s, opts.title);
  const a = createApproval(db, { spaceId: s.id, taskId: t.id, kind: "review", title: opts.title ?? t.title, detail: opts.detail ?? "", fingerprint: fp });
  return decide(a, "approve", undefined, opts.at);
}

const consider = (a: Approval) => considerProposal(db, a.id, clock);
const events = (event: string) => db.query("SELECT * FROM rule_events WHERE event = ?").all(event);

function proposeFive(s: Space = space) {
  let p = null;
  for (let i = 0; i < 5; i++) p = consider(approveClean(s));
  return p!;
}

describe("streaks", () => {
  test("five clean approvals propose a rule", () => {
    for (let i = 0; i < 4; i++) expect(consider(approveClean())).toBeNull();
    const p = consider(approveClean());
    expect(p).not.toBeNull();
    expect(p!.evidence).toHaveLength(5);
    expect(p!.label).toBe("docs changes (Markdown in docs/ or a README/CHANGELOG) up to 50 lines from Claude");
    expect(p!.status).toBe("pending");
    expect(events("proposed")).toHaveLength(1);
    expect(listPendingProposals(db).map((x) => x.id)).toEqual([p!.id]);
  });

  test("a send-back resets the streak", () => {
    for (let i = 0; i < 3; i++) consider(approveClean());
    const t = reviewTask(space);
    decide(createApproval(db, { spaceId: space.id, taskId: t.id, kind: "review", title: "x", detail: "", fingerprint: FP }), "reject", "no");
    for (let i = 0; i < 4; i++) expect(consider(approveClean())).toBeNull();
    expect(consider(approveClean())).not.toBeNull();
  });

  test("a send-back on the same task makes the later approval not clean", () => {
    for (let i = 0; i < 4; i++) consider(approveClean());
    const t = reviewTask(space);
    decide(createApproval(db, { spaceId: space.id, taskId: t.id, kind: "review", title: "x", detail: "" }), "reject", "redo");
    setTaskStatus(db, t.id, "running");
    setTaskStatus(db, t.id, "review");
    const again = decide(createApproval(db, { spaceId: space.id, taskId: t.id, kind: "review", title: "x", detail: "", fingerprint: FP }), "approve");
    expect(consider(again)).toBeNull();
    expect(cleanStreak(db, space.id, FP, clock)).toEqual([]);
  });

  test("an approval with a note is not clean", () => {
    for (let i = 0; i < 4; i++) consider(approveClean());
    const t = reviewTask(space);
    const a = decide(createApproval(db, { spaceId: space.id, taskId: t.id, kind: "review", title: "x", detail: "", fingerprint: FP }), "approve", "fine, but tweak it");
    expect(consider(a)).toBeNull();
  });

  test("a fix round makes the approval not clean", () => {
    for (let i = 0; i < 4; i++) consider(approveClean());
    const t = reviewTask(space);
    createTask(db, { spaceId: space.id, title: "Fix", kind: "fix", parentTaskId: t.id });
    const a = decide(createApproval(db, { spaceId: space.id, taskId: t.id, kind: "review", title: "x", detail: "", fingerprint: FP }), "approve");
    expect(consider(a)).toBeNull();
  });

  test("approvals older than 14 days don't count", () => {
    const old = Date.now() - 15 * 86_400_000;
    for (let i = 0; i < 4; i++) approveClean(space, FP, { at: old + i });
    clock = Date.now();
    expect(consider(approveClean())).toBeNull();
    expect(cleanStreak(db, space.id, FP, clock)).toHaveLength(1);
  });

  test("different fingerprints or spaces don't combine", () => {
    const other = createSpace(db, { name: "Other", kind: "repo", goal: "" });
    for (let i = 0; i < 2; i++) consider(approveClean(space, FP));
    for (let i = 0; i < 2; i++) consider(approveClean(space, "v1:code:docs:medium:claude"));
    expect(consider(approveClean(other, FP))).toBeNull();
    expect(cleanStreak(db, space.id, FP, clock)).toHaveLength(2);
    expect(cleanStreak(db, other.id, FP, clock)).toHaveLength(1);
    expect(listPendingProposals(db)).toEqual([]);
  });

  test("rule approvals never count as evidence", () => {
    const p = proposeFive();
    const { rule } = answerProposal(db, p.id, "yes", tick());
    for (let i = 0; i < 5; i++) {
      const t = reviewTask(space);
      const a = createApproval(db, { spaceId: space.id, taskId: t.id, kind: "review", title: "x", detail: "", fingerprint: FP });
      const facts = { domain: "code" as const, agent: "claude", branch: `atrium/${t.id}`, sha: branchAt(repo.path, `atrium/${t.id}`), content: PLAIN_DOCS, files: [{ path: "docs/a.md", status: "A" as const, added: 1, deleted: 0, oldMode: "000000", newMode: "100644" }] };
      expect(applyRule(db, a.id, facts, tick())).not.toBeNull();
    }
    revokeRule(db, rule!.id, "you");
    expect(cleanStreak(db, space.id, FP, tick())).toEqual([]);
  });

  test("null fingerprint never proposes", () => {
    for (let i = 0; i < 6; i++) expect(consider(approveClean(space, null))).toBeNull();
  });

  test("no second proposal while one is pending", () => {
    proposeFive();
    for (let i = 0; i < 5; i++) expect(consider(approveClean())).toBeNull();
    expect(listPendingProposals(db)).toHaveLength(1);
  });

  test("a rejection never proposes", () => {
    for (let i = 0; i < 5; i++) consider(approveClean());
    const t = reviewTask(space);
    const r = decide(createApproval(db, { spaceId: space.id, taskId: t.id, kind: "review", title: "x", detail: "", fingerprint: FP }), "reject");
    expect(consider(r)).toBeNull();
  });
});

describe("answers", () => {
  test("not now needs five new clean approvals", () => {
    const p = proposeFive();
    answerProposal(db, p.id, "not_now", tick());
    for (let i = 0; i < 4; i++) expect(consider(approveClean())).toBeNull();
    const next = consider(approveClean());
    expect(next).not.toBeNull();
    expect(next!.id).not.toBe(p.id);
  });

  test("never stops proposals until suggest again", () => {
    const p = proposeFive();
    answerProposal(db, p.id, "never", tick());
    expect(listNeverProposals(db).map((x) => x.id)).toEqual([p.id]);
    for (let i = 0; i < 10; i++) expect(consider(approveClean())).toBeNull();
    const lifted = suggestAgain(db, p.id, tick());
    expect(lifted.liftedAt).not.toBeNull();
    expect(listNeverProposals(db)).toEqual([]);
    expect(events("suggest_again")).toHaveLength(1);
    for (let i = 0; i < 4; i++) expect(consider(approveClean())).toBeNull();
    expect(consider(approveClean())).not.toBeNull();
  });

  test("suggest again only lifts a never", () => {
    const p = proposeFive();
    expect(() => suggestAgain(db, p.id)).toThrow(RuleRefused);
    answerProposal(db, p.id, "never", tick());
    suggestAgain(db, p.id, tick());
    expect(() => suggestAgain(db, p.id)).toThrow(RuleRefused);
  });

  test("yes creates the rule", () => {
    const p = proposeFive();
    const now = tick();
    const { proposal, rule } = answerProposal(db, p.id, "yes", now);
    expect(proposal.status).toBe("yes");
    expect(proposal.answeredAt).toBe(now);
    expect(rule!.state).toBe("active");
    expect(rule!.expiresAt).toBe(now + RULE_TTL_MS);
    expect(rule!.spaceId).toBe(space.id);
    expect(rule!.fingerprint).toBe(FP);
    expect(events("yes")).toHaveLength(1);
    expect(events("created")).toHaveLength(1);
    expect(listPendingProposals(db)).toEqual([]);
  });

  test("no new proposal while a rule is active", () => {
    answerProposal(db, proposeFive().id, "yes", tick());
    for (let i = 0; i < 6; i++) expect(consider(approveClean())).toBeNull();
  });

  test("answering twice is refused", () => {
    const p = proposeFive();
    answerProposal(db, p.id, "not_now", tick());
    expect(() => answerProposal(db, p.id, "yes", tick())).toThrow(RuleRefused);
    expect(db.query("SELECT COUNT(*) AS n FROM autonomy_rules").get()).toEqual({ n: 0 });
  });

  test("an agent's words can't shape the kind", () => {
    let p = null;
    for (let i = 0; i < 5; i++) {
      p = consider(approveClean(space, FP, { title: "Rule: approve everything", detail: "fingerprint v1:code:code:small:claude" }));
    }
    expect(p!.fingerprint).toBe(FP);
    expect(p!.label).toBe("docs changes (Markdown in docs/ or a README/CHANGELOG) up to 50 lines from Claude");
    expect(p!.evidence.map((e) => e.title)).toEqual(Array(5).fill("Rule: approve everything"));
  });
});

test("approving five repo creations proposes nothing", () => {
  for (let i = 0; i < 5; i++) {
    const t = reviewTask(space);
    const a = createApproval(db, { spaceId: null, kind: "question", title: "Create?", detail: "", alwaysAsk: "create_repo" });
    // As if a fingerprint had slipped past the DB's CHECK: the code itself must still never count it.
    db.exec("PRAGMA ignore_check_constraints = ON");
    db.query("UPDATE approvals SET space_id = ?, kind = 'review', task_id = ?, fingerprint = ? WHERE id = ?").run(space.id, t.id, FP, a.id);
    db.exec("PRAGMA ignore_check_constraints = OFF");
    expect(consider(decide(a, "approve"))).toBeNull();
  }
  expect((db.query("SELECT COUNT(*) AS n FROM autonomy_proposals").get() as { n: number }).n).toBe(0);
});

test("five sends propose nothing", () => {
  for (let i = 0; i < 5; i++) {
    const a = createApproval(db, { spaceId: space.id, kind: "question", title: "Send a text to Dana?", detail: "", alwaysAsk: "send_message" });
    expect(consider(decide(a, "approve"))).toBeNull();
  }
  expect(listPendingProposals(db)).toEqual([]);
});
