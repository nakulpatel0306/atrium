import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createApproval, getApproval, resolveApproval } from "../../src/engine/approvals";
import { type ActionFacts, RULE_TTL_MS } from "../../src/engine/autonomy/kinds";
import {
  applyRule,
  createRule,
  listRules,
  renewRule,
  revokeRule,
  ruleApprovals,
  ruleEvents,
  RuleRefused,
  undoAutoApproval,
} from "../../src/engine/autonomy/rules";
import { openDb } from "../../src/engine/db";
import type { ChangedFile } from "../../src/engine/git";
import { createSpace, type Space } from "../../src/engine/spaces";
import { createTask, getTask, setTaskStatus } from "../../src/engine/tasks";
import { branchAt, PLAIN_DOCS, tempHome, tempRepo } from "../helpers";

const FP = "v1:code:docs:small:claude";
let home: ReturnType<typeof tempHome>;
let db: Database;
let space: Space;
let repo: ReturnType<typeof tempRepo>;

beforeEach(() => {
  home = tempHome();
  db = openDb();
  repo = tempRepo();
  space = createSpace(db, { name: "Docs", kind: "repo", goal: "write", repoPath: repo.path });
});
afterEach(() => {
  db.close();
  home.cleanup();
  repo.cleanup();
});

const file = (path: string, added = 5, status: ChangedFile["status"] = "A"): ChangedFile => ({
  path,
  status,
  added: status === "D" ? 0 : added,
  deleted: status === "D" ? 3 : 0,
  oldMode: status === "A" ? "000000" : "100644",
  newMode: status === "D" ? "000000" : "100644",
});

function pending(s: Space = space) {
  const t = createTask(db, { spaceId: s.id, title: "Add a note" });
  setTaskStatus(db, t.id, "running");
  setTaskStatus(db, t.id, "review", { branch: `atrium/${t.id}` });
  const a = createApproval(db, { spaceId: s.id, taskId: t.id, kind: "review", title: "Add a note", detail: "1 commit", fingerprint: FP });
  const branch = `atrium/${t.id}`;
  const facts: ActionFacts = { domain: "code", agent: "claude", branch, sha: branchAt(repo.path, branch), files: [file("docs/a.md")], content: PLAIN_DOCS };
  return { t, a, facts };
}

let proposals = 0;
function proposal(s: Space = space, fp = FP, status = "yes"): string {
  const id = `prp_${++proposals}`;
  db.query("INSERT INTO autonomy_proposals (id, space_id, fingerprint, evidence, status, created_at) VALUES (?, ?, ?, '[]', ?, 1)").run(id, s.id, fp, status);
  return id;
}

// Created a second in the past, so approvals made right after it are newer.
const rule = (s: Space = space, fp = FP) => createRule(db, proposal(s, fp), Date.now() - 1000);
const ruleCount = () => (db.query("SELECT COUNT(*) AS n FROM autonomy_rules").get() as { n: number }).n;
const events = (event: string) => (db.query("SELECT * FROM rule_events WHERE event = ?").all(event) as { approval_id: string | null }[]);

describe("createRule", () => {
  test("createRule refuses a fingerprint outside the grammar", () => {
    for (const fp of ["v1:code:code:small:claude", "v1:delete:x", "*"]) {
      expect(() => createRule(db, proposal(space, fp))).toThrow(RuleRefused);
    }
    expect(ruleCount()).toBe(0);
  });

  test("a new rule is active for 60 days and logged", () => {
    const now = Date.now();
    const r = createRule(db, proposal(), now);
    expect(r).toMatchObject({ state: "active", expiresAt: now + RULE_TTL_MS, label: "docs changes (Markdown in docs/ or a README/CHANGELOG) up to 50 lines from Claude", appliedCount: 0 });
    expect(events("created")).toHaveLength(1);
  });

  test("a rule covers exactly its proposal's space and kind", () => {
    const other = createSpace(db, { name: "Other", kind: "repo", goal: "", repoPath: repo.path });
    const r = createRule(db, proposal(other, "v1:general:text:codex"));
    expect(r).toMatchObject({ spaceId: other.id, fingerprint: "v1:general:text:codex" });
  });

  test("only a suggestion Nakul said yes to makes a rule", () => {
    for (const status of ["pending", "not_now", "never"]) expect(() => createRule(db, proposal(space, FP, status))).toThrow(RuleRefused);
    expect(() => createRule(db, "prp_missing")).toThrow(RuleRefused);
    expect(ruleCount()).toBe(0);
  });

  test("a suggestion makes at most one rule", () => {
    const id = proposal();
    const r = createRule(db, id);
    revokeRule(db, r.id, "you");
    expect(() => createRule(db, id)).toThrow(RuleRefused);
    expect(ruleCount()).toBe(1);
  });

  test("no second active rule for the same space and kind", () => {
    createRule(db, proposal());
    expect(() => createRule(db, proposal())).toThrow(RuleRefused);
    expect(ruleCount()).toBe(1);
  });
});

describe("applyRule", () => {
  test("applyRule approves a matching result", () => {
    const r = rule();
    const { t, a, facts } = pending();
    const res = applyRule(db, a.id, facts);
    expect(res?.decidedBy).toBe("rule");
    expect(res?.ruleId).toBe(r.id);
    expect(getTask(db, t.id)!.status).toBe("done");
    expect(events("applied").map((e) => e.approval_id)).toEqual([a.id]);
    expect(listRules(db)[0]!.appliedCount).toBe(1);
  });

  test("rule can't match a forbidden kind", () => {
    db.query("INSERT INTO autonomy_rules (id, space_id, fingerprint, proposal_id, created_at, expires_at) VALUES ('rul_hand', ?, ?, ?, 1, ?)").run(
      space.id,
      FP,
      proposal(),
      Date.now() + RULE_TTL_MS,
    );
    const extras: Array<(f: ActionFacts & { domain: "code" }) => ActionFacts> = [
      (f) => ({ ...f, files: [...f.files, file("old.md", 0, "D")] }),
      (f) => ({ ...f, files: [...f.files, file(".env.local")] }),
      (f) => ({ ...f, files: [...f.files, file(".github/workflows/ci.yml", 1, "M")] }),
      (f) => ({ ...f, branch: "main" }),
    ];
    for (const change of extras) {
      const { a, facts } = pending();
      expect(applyRule(db, a.id, change(facts as ActionFacts & { domain: "code" }))).toBeNull();
      expect(getApproval(db, a.id)!.status).toBe("pending");
    }
  });

  test("fingerprint drift asks", () => {
    rule();
    const { a, facts } = pending();
    expect(applyRule(db, a.id, { ...facts, files: [file("docs/a.md", 80)] } as ActionFacts)).toBeNull();
    expect(getApproval(db, a.id)!.status).toBe("pending");
  });

  test("missing branch asks", () => {
    rule();
    const { a } = pending();
    expect(applyRule(db, a.id, null)).toBeNull();
  });

  test("rule does not sweep approvals created before it", () => {
    const { a, facts } = pending();
    createRule(db, proposal(), Date.now() + 1000);
    expect(applyRule(db, a.id, facts)).toBeNull();
    expect(getApproval(db, a.id)!.status).toBe("pending");
  });

  test("an approval without a kind is never applied", () => {
    rule();
    const t = createTask(db, { spaceId: space.id, title: "x" });
    setTaskStatus(db, t.id, "running");
    setTaskStatus(db, t.id, "review");
    const a = createApproval(db, { spaceId: space.id, taskId: t.id, kind: "review", title: "x", detail: "" });
    const branch = `atrium/${t.id}`;
    expect(applyRule(db, a.id, { domain: "code", agent: "claude", branch, sha: branchAt(repo.path, branch), files: [file("docs/a.md")], content: PLAIN_DOCS })).toBeNull();
  });

  test("revoked rule stops applying immediately", () => {
    const r = rule();
    revokeRule(db, r.id, "you");
    const { a, facts } = pending();
    expect(applyRule(db, a.id, facts)).toBeNull();
    expect(listRules(db)[0]!.state).toBe("revoked");
    expect(listRules(db)[0]!.revokedReason).toBe("you");
  });

  test("expired rule stops applying", () => {
    const r = rule();
    const { a, facts } = pending();
    expect(applyRule(db, a.id, facts, r.expiresAt)).toBeNull();
    expect(listRules(db, r.expiresAt)[0]!.state).toBe("expired");
    expect(() => renewRule(db, r.id, r.expiresAt)).toThrow(RuleRefused);
  });

  test("renew extends from now", () => {
    const r = rule();
    const t = Date.now() + 5 * 86_400_000;
    expect(renewRule(db, r.id, t).expiresAt).toBe(t + RULE_TTL_MS);
    expect(events("renewed")).toHaveLength(1);
  });

  test("rule in one space doesn't apply in another", () => {
    rule();
    const other = createSpace(db, { name: "Other", kind: "repo", goal: "", repoPath: repo.path });
    const { a, facts } = pending(other);
    expect(applyRule(db, a.id, facts)).toBeNull();
  });

  test("daily cap", () => {
    rule();
    for (let i = 0; i < 10; i++) {
      const { a, facts } = pending();
      expect(applyRule(db, a.id, facts)).not.toBeNull();
    }
    const { a, facts } = pending();
    expect(applyRule(db, a.id, facts)).toBeNull();
    expect(applyRule(db, a.id, facts)).toBeNull();
    const after = getApproval(db, a.id)!;
    expect(after.status).toBe("pending");
    expect(after.detail).toContain("Your rules already approved 10 results in this space today, so this one waits for you.");
    expect(after.detail.match(/already approved 10 results/g)).toHaveLength(1);
    expect(events("skipped_cap")).toHaveLength(1);
  });

  test("the daily cap counts every rule in the space", () => {
    rule();
    for (let i = 0; i < 10; i++) {
      const { a, facts } = pending();
      expect(applyRule(db, a.id, facts)).not.toBeNull();
    }
    // A second rule for another kind in the same space shares the space's ten.
    rule(space, "v1:code:docs:medium:claude");
    const t = createTask(db, { spaceId: space.id, title: "Bigger note" });
    setTaskStatus(db, t.id, "running");
    setTaskStatus(db, t.id, "review", { branch: `atrium/${t.id}` });
    const a = createApproval(db, { spaceId: space.id, taskId: t.id, kind: "review", title: "Bigger note", detail: "", fingerprint: "v1:code:docs:medium:claude" });
    const branch = `atrium/${t.id}`;
    const facts: ActionFacts = { domain: "code", agent: "claude", branch, sha: branchAt(repo.path, branch), files: [file("docs/a.md", 80)], content: PLAIN_DOCS };
    expect(applyRule(db, a.id, facts)).toBeNull();
    // Another space keeps its own ten.
    const otherRepo = tempRepo();
    try {
      const other = createSpace(db, { name: "Other", kind: "repo", goal: "", repoPath: otherRepo.path });
      createRule(db, proposal(other), Date.now() - 1000);
      const t2 = createTask(db, { spaceId: other.id, title: "Note" });
      setTaskStatus(db, t2.id, "running");
      setTaskStatus(db, t2.id, "review", { branch: `atrium/${t2.id}` });
      const a2 = createApproval(db, { spaceId: other.id, taskId: t2.id, kind: "review", title: "Note", detail: "", fingerprint: FP });
      const b2 = `atrium/${t2.id}`;
      expect(applyRule(db, a2.id, { domain: "code", agent: "claude", branch: b2, sha: branchAt(otherRepo.path, b2), files: [file("docs/a.md")], content: PLAIN_DOCS })).not.toBeNull();
    } finally {
      otherRepo.cleanup();
    }
  });

  test("a task with an earlier send-back is never auto-approved", () => {
    rule();
    const { t, a, facts } = pending();
    resolveApproval(db, a.id, "reject", "tighten the wording");
    setTaskStatus(db, t.id, "running");
    setTaskStatus(db, t.id, "review");
    const redo = createApproval(db, { spaceId: space.id, taskId: t.id, kind: "review", title: "Add a note", detail: "", fingerprint: FP });
    expect(applyRule(db, redo.id, facts)).toBeNull();
    expect(getApproval(db, redo.id)!.status).toBe("pending");
  });

  test("a task whose automatic approval was undone is never auto-approved again", () => {
    rule();
    const { a, facts } = pending();
    applyRule(db, a.id, facts);
    const reopened = undoAutoApproval(db, a.id);
    rule();
    expect(applyRule(db, reopened.id, facts)).toBeNull();
    expect(getApproval(db, reopened.id)!.status).toBe("pending");
  });

  test("the branch must still be at the commit that was classified", () => {
    rule();
    const { t, a, facts } = pending();
    Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "later"], { cwd: repo.path });
    branchAt(repo.path, `atrium/${t.id}`);
    expect(applyRule(db, a.id, facts)).toBeNull();
    expect(getApproval(db, a.id)!.status).toBe("pending");
  });

  test("the approval records the commit that was classified", () => {
    rule();
    const { a, facts } = pending();
    const res = applyRule(db, a.id, facts)!;
    expect(res.branchHead).toBe((facts as { sha: string }).sha);
  });

  test("a manual decision is never overridden", () => {
    rule();
    const { a, facts } = pending();
    resolveApproval(db, a.id, "reject", "no");
    expect(applyRule(db, a.id, facts)).toBeNull();
    expect(getApproval(db, a.id)!.status).toBe("rejected");
  });
});

describe("revoke and undo", () => {
  test("revoking twice is refused", () => {
    const r = rule();
    revokeRule(db, r.id, "you");
    expect(() => revokeRule(db, r.id, "you")).toThrow(RuleRefused);
  });

  test("undo reopens the task, makes a new approval and revokes the rule", () => {
    const r = rule();
    const { t, a, facts } = pending();
    applyRule(db, a.id, facts);
    const next = undoAutoApproval(db, a.id);
    expect(next.status).toBe("pending");
    expect(next.id).not.toBe(a.id);
    expect(next.taskId).toBe(t.id);
    expect(next.fingerprint).toBe(FP);
    expect(next.detail.endsWith("Reopened: you undid the automatic approval.")).toBe(true);
    expect(getApproval(db, a.id)!.undoneAt).not.toBeNull();
    expect(getTask(db, t.id)!.status).toBe("review");
    const after = listRules(db).find((x) => x.id === r.id)!;
    expect(after.state).toBe("revoked");
    expect(after.revokedReason).toBe("undone");
    expect(ruleApprovals(db, r.id).map((x) => x.id)).toEqual([a.id]);
    expect(ruleEvents(db, r.id).map((e) => e.event)).toEqual(["created", "applied", "undone", "revoked"]);
  });

  test("undo after revoke", () => {
    const r = rule();
    const { a, facts } = pending();
    applyRule(db, a.id, facts);
    revokeRule(db, r.id, "you");
    expect(undoAutoApproval(db, a.id).status).toBe("pending");
    expect(events("revoked")).toHaveLength(1);
    expect(listRules(db)[0]!.revokedReason).toBe("you");
  });

  test("undo twice", () => {
    rule();
    const { a, facts } = pending();
    applyRule(db, a.id, facts);
    undoAutoApproval(db, a.id);
    expect(() => undoAutoApproval(db, a.id)).toThrow(RuleRefused);
  });

  test("undo a manual approval", () => {
    const { a } = pending();
    resolveApproval(db, a.id, "approve");
    expect(() => undoAutoApproval(db, a.id)).toThrow(RuleRefused);
  });
});
