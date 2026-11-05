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
import { tempHome } from "../helpers";

const FP = "v1:code:docs:small:claude";
let home: ReturnType<typeof tempHome>;
let db: Database;
let space: Space;

beforeEach(() => {
  home = tempHome();
  db = openDb();
  space = createSpace(db, { name: "Docs", kind: "general", goal: "write" });
});
afterEach(() => {
  db.close();
  home.cleanup();
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
  const facts: ActionFacts = { domain: "code", agent: "claude", branch: `atrium/${t.id}`, files: [file("docs/a.md")] };
  return { t, a, facts };
}

let proposals = 0;
function proposal(s: Space = space, fp = FP): string {
  const id = `prp_${++proposals}`;
  db.query("INSERT INTO autonomy_proposals (id, space_id, fingerprint, evidence, status, created_at) VALUES (?, ?, ?, '[]', 'yes', 1)").run(id, s.id, fp);
  return id;
}

// Created a second in the past, so approvals made right after it are newer.
const rule = (s: Space = space, fp = FP) => createRule(db, { spaceId: s.id, fingerprint: fp, proposalId: proposal(s, fp) }, Date.now() - 1000);
const events = (event: string) => (db.query("SELECT * FROM rule_events WHERE event = ?").all(event) as { approval_id: string | null }[]);

describe("createRule", () => {
  test("createRule refuses a fingerprint outside the grammar", () => {
    for (const fp of ["v1:code:code:small:claude", "v1:delete:x", "*"]) {
      expect(() => createRule(db, { spaceId: space.id, fingerprint: fp, proposalId: proposal(space, fp) })).toThrow(RuleRefused);
    }
    expect(db.query("SELECT COUNT(*) AS n FROM autonomy_rules").get()).toEqual({ n: 0 });
  });

  test("a new rule is active for 60 days and logged", () => {
    const now = Date.now();
    const r = createRule(db, { spaceId: space.id, fingerprint: FP, proposalId: proposal() }, now);
    expect(r).toMatchObject({ state: "active", expiresAt: now + RULE_TTL_MS, label: "docs-only changes under 50 lines from Claude", appliedCount: 0 });
    expect(events("created")).toHaveLength(1);
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
    createRule(db, { spaceId: space.id, fingerprint: FP, proposalId: proposal() }, Date.now() + 1000);
    expect(applyRule(db, a.id, facts)).toBeNull();
    expect(getApproval(db, a.id)!.status).toBe("pending");
  });

  test("an approval without a kind is never applied", () => {
    rule();
    const t = createTask(db, { spaceId: space.id, title: "x" });
    setTaskStatus(db, t.id, "running");
    setTaskStatus(db, t.id, "review");
    const a = createApproval(db, { spaceId: space.id, taskId: t.id, kind: "review", title: "x", detail: "" });
    expect(applyRule(db, a.id, { domain: "code", agent: "claude", branch: `atrium/${t.id}`, files: [file("docs/a.md")] })).toBeNull();
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
    const other = createSpace(db, { name: "Other", kind: "general", goal: "" });
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
    expect(after.detail).toContain('Your rule "docs-only changes under 50 lines from Claude" already approved 10 today, so this one waits for you.');
    expect(after.detail.match(/already approved 10 today/g)).toHaveLength(1);
    expect(events("skipped_cap")).toHaveLength(1);
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
