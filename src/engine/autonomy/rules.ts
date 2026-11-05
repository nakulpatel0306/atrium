import type { Database } from "bun:sqlite";
import { type Approval, appendApprovalDetail, createApproval, getApproval, resolveApproval } from "../approvals";
import { bus } from "../events";
import { branchHeadSync } from "../git";
import { getSpace } from "../spaces";
import { newId } from "../ids";
import { getTask, reopenForReview } from "../tasks";
import { type ActionFacts, DAILY_CAP, fingerprintOf, forbiddenFor, labelOf, parseFingerprint, RULE_TTL_MS } from "./kinds";

const DAY_MS = 86_400_000;

export type RuleEvent =
  | "proposed"
  | "yes"
  | "not_now"
  | "never"
  | "suggest_again"
  | "created"
  | "applied"
  | "undone"
  | "revoked"
  | "renewed"
  | "skipped_cap";

export type Rule = {
  id: string;
  spaceId: string;
  fingerprint: string;
  label: string;
  proposalId: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  revokedReason: string | null;
  state: "active" | "expired" | "revoked";
  appliedCount: number;
};

export type RuleEventRow = {
  id: string;
  spaceId: string;
  proposalId: string | null;
  ruleId: string | null;
  approvalId: string | null;
  event: RuleEvent;
  actor: "you" | "atrium";
  createdAt: number;
};

type RuleRow = {
  id: string;
  space_id: string;
  fingerprint: string;
  proposal_id: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  revoked_reason: string | null;
  applied: number;
};

export class RuleRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleRefused";
  }
}

const SELECT = "SELECT r.*, (SELECT COUNT(*) FROM approvals a WHERE a.rule_id = r.id) AS applied FROM autonomy_rules r";

const toRule = (r: RuleRow, now: number): Rule => ({
  id: r.id,
  spaceId: r.space_id,
  fingerprint: r.fingerprint,
  label: labelOf(r.fingerprint),
  proposalId: r.proposal_id,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  revokedAt: r.revoked_at,
  revokedReason: r.revoked_reason,
  state: r.revoked_at !== null ? "revoked" : r.expires_at <= now ? "expired" : "active",
  appliedCount: r.applied,
});

// Rows are only ever added: this is the record of everything a rule was asked, told and did.
export function logRuleEvent(
  db: Database,
  e: { spaceId: string; event: RuleEvent; actor: "you" | "atrium"; proposalId?: string; ruleId?: string; approvalId?: string },
  now = Date.now(),
): void {
  db.query(
    "INSERT INTO rule_events (id, space_id, proposal_id, rule_id, approval_id, event, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(newId("rev"), e.spaceId, e.proposalId ?? null, e.ruleId ?? null, e.approvalId ?? null, e.event, e.actor, now);
}

export function getRule(db: Database, id: string, now = Date.now()): Rule | null {
  const row = db.query(`${SELECT} WHERE r.id = ?`).get(id) as RuleRow | null;
  return row ? toRule(row, now) : null;
}

// A rule exists only because Nakul said yes to a suggestion: its space and kind come from that suggestion's
// row and nowhere else, and each suggestion makes at most one rule.
export function createRule(db: Database, proposalId: string, now = Date.now()): Rule {
  const id = newId("rul");
  db.transaction(() => {
    const p = db.query("SELECT space_id, fingerprint, status FROM autonomy_proposals WHERE id = ?").get(proposalId) as {
      space_id: string;
      fingerprint: string;
      status: string;
    } | null;
    if (p?.status !== "yes") throw new RuleRefused("A rule needs a suggestion you said yes to.");
    if (!parseFingerprint(p.fingerprint)) throw new RuleRefused("Atrium can't make a rule for this kind of result.");
    if (db.query("SELECT 1 FROM autonomy_rules WHERE proposal_id = ?").get(proposalId)) {
      throw new RuleRefused("This suggestion already made a rule.");
    }
    if (activeRuleFor(db, p.space_id, p.fingerprint, now)) throw new RuleRefused("A rule for this already exists.");
    db.query(
      "INSERT INTO autonomy_rules (id, space_id, fingerprint, proposal_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, p.space_id, p.fingerprint, proposalId, now, now + RULE_TTL_MS);
    logRuleEvent(db, { spaceId: p.space_id, event: "created", actor: "you", proposalId, ruleId: id }, now);
  })();
  bus.emit({ type: "changed" });
  return getRule(db, id, now)!;
}

export function activeRuleFor(db: Database, spaceId: string, fingerprint: string, now = Date.now()): Rule | null {
  const row = db
    .query(`${SELECT} WHERE r.space_id = ? AND r.fingerprint = ? AND r.revoked_at IS NULL AND r.expires_at > ? ORDER BY r.created_at DESC LIMIT 1`)
    .get(spaceId, fingerprint, now) as RuleRow | null;
  return row ? toRule(row, now) : null;
}

// Facts are re-read from git by the caller just before this, at one commit; the branch must still be there when the
// rule decides, so what gets approved is exactly what was classified. Any doubt leaves the item waiting for Nakul.
export function applyRule(db: Database, approvalId: string, facts: ActionFacts | null, now = Date.now()): Approval | null {
  let capped = false;
  const result = db.transaction((): Approval | null => {
    const a = getApproval(db, approvalId);
    if (a?.status !== "pending" || a.kind !== "review" || !a.fingerprint || !facts) return null;
    if (forbiddenFor(facts).length > 0 || fingerprintOf(facts) !== a.fingerprint) return null;
    // Once Nakul has sent a task back, or undone a rule's approval of it, only he decides on it again.
    const doubted = db
      .query("SELECT 1 FROM approvals WHERE task_id = ? AND id != ? AND (status = 'rejected' OR undone_at IS NOT NULL)")
      .get(a.taskId, a.id);
    if (doubted) return null;
    let head: string | undefined;
    if (facts.domain === "code") {
      const task = a.taskId ? getTask(db, a.taskId) : null;
      const repo = getSpace(db, a.spaceId)?.repoPath;
      if (!repo || task?.branch !== facts.branch || branchHeadSync(repo, facts.branch) !== facts.sha) return null;
      head = facts.sha;
    }
    const rule = activeRuleFor(db, a.spaceId, a.fingerprint, now);
    // A rule covers results that arrive after it, never ones already waiting when Nakul said yes.
    if (!rule || rule.createdAt >= a.createdAt) return null;
    // Per space, across all its rules: a burst of automatic approvals is worth a look whichever rule made them.
    const today = db
      .query("SELECT COUNT(*) AS n FROM rule_events WHERE space_id = ? AND event = 'applied' AND created_at > ?")
      .get(a.spaceId, now - DAY_MS) as { n: number };
    if (today.n >= DAILY_CAP) {
      const seen = db.query("SELECT 1 FROM rule_events WHERE approval_id = ? AND event = 'skipped_cap'").get(a.id);
      if (!seen) {
        logRuleEvent(db, { spaceId: a.spaceId, event: "skipped_cap", actor: "atrium", ruleId: rule.id, approvalId: a.id }, now);
        appendApprovalDetail(db, a.id, `\n\nYour rules already approved ${DAILY_CAP} results in this space today, so this one waits for you.`);
        capped = true;
      }
      return null;
    }
    const resolved = resolveApproval(db, a.id, "approve", undefined, { id: rule.id, label: rule.label, head });
    logRuleEvent(db, { spaceId: a.spaceId, event: "applied", actor: "atrium", ruleId: rule.id, approvalId: a.id }, now);
    return resolved;
  })();
  if (result || capped) bus.emit({ type: "changed" });
  return result;
}

function revokeIn(db: Database, rule: Rule, reason: "you" | "undone", now: number): void {
  db.query("UPDATE autonomy_rules SET revoked_at = ?, revoked_reason = ? WHERE id = ?").run(now, reason, rule.id);
  logRuleEvent(db, { spaceId: rule.spaceId, event: "revoked", actor: "you", ruleId: rule.id }, now);
}

export function revokeRule(db: Database, id: string, reason: "you" | "undone", now = Date.now()): Rule {
  db.transaction(() => {
    const rule = getRule(db, id, now);
    if (!rule) throw new RuleRefused("No such rule.");
    if (rule.state !== "active") throw new RuleRefused("This rule is already off.");
    revokeIn(db, rule, reason, now);
  })();
  bus.emit({ type: "changed" });
  return getRule(db, id, now)!;
}

export function renewRule(db: Database, id: string, now = Date.now()): Rule {
  db.transaction(() => {
    const rule = getRule(db, id, now);
    if (!rule) throw new RuleRefused("No such rule.");
    if (rule.state !== "active") throw new RuleRefused("This rule has ended. Atrium will suggest it again after more approvals.");
    db.query("UPDATE autonomy_rules SET expires_at = ? WHERE id = ?").run(now + RULE_TTL_MS, id);
    logRuleEvent(db, { spaceId: rule.spaceId, event: "renewed", actor: "you", ruleId: id }, now);
  })();
  bus.emit({ type: "changed" });
  return getRule(db, id, now)!;
}

// Puts the task back in Needs you and turns the rule off: a rule Nakul had to undo is one he doesn't trust.
export function undoAutoApproval(db: Database, approvalId: string, now = Date.now()): Approval {
  const next = db.transaction((): Approval => {
    const a = getApproval(db, approvalId);
    if (!a || a.decidedBy !== "rule" || !a.ruleId) throw new RuleRefused("Only an automatic approval can be undone.");
    if (a.undoneAt !== null) throw new RuleRefused("This automatic approval was already undone.");
    const task = a.taskId ? getTask(db, a.taskId) : null;
    if (task?.status !== "done" || task.kind !== "work") {
      throw new RuleRefused("This task changed after it was approved, so it can't be reopened. Ask for the change again as a new task.");
    }
    db.query("UPDATE approvals SET undone_at = ? WHERE id = ?").run(now, a.id);
    reopenForReview(db, task.id);
    const reopened = createApproval(db, {
      spaceId: a.spaceId,
      taskId: task.id,
      kind: a.kind,
      title: a.title,
      detail: `${a.detail}\n\nReopened: you undid the automatic approval.`,
      fingerprint: a.fingerprint,
    });
    logRuleEvent(db, { spaceId: a.spaceId, event: "undone", actor: "you", ruleId: a.ruleId, approvalId: a.id }, now);
    const rule = getRule(db, a.ruleId, now);
    if (rule?.state === "active") revokeIn(db, rule, "undone", now);
    return reopened;
  })();
  bus.emit({ type: "changed" });
  return next;
}

export function listRules(db: Database, now = Date.now()): Rule[] {
  const rows = db.query(`${SELECT} ORDER BY r.created_at DESC, r.rowid DESC`).all() as RuleRow[];
  return rows.map((r) => toRule(r, now));
}

export function ruleApprovals(db: Database, ruleId: string): Approval[] {
  const ids = db.query("SELECT id FROM approvals WHERE rule_id = ? ORDER BY resolved_at DESC, rowid DESC").all(ruleId) as { id: string }[];
  return ids.map((r) => getApproval(db, r.id)!);
}

export function ruleEvents(db: Database, ruleId: string): RuleEventRow[] {
  const rows = db
    .query(
      `SELECT * FROM rule_events WHERE rule_id = ? OR proposal_id = (SELECT proposal_id FROM autonomy_rules WHERE id = ?)
       ORDER BY created_at, rowid`,
    )
    .all(ruleId, ruleId) as {
    id: string;
    space_id: string;
    proposal_id: string | null;
    rule_id: string | null;
    approval_id: string | null;
    event: RuleEvent;
    actor: "you" | "atrium";
    created_at: number;
  }[];
  return rows.map((r) => ({
    id: r.id,
    spaceId: r.space_id,
    proposalId: r.proposal_id,
    ruleId: r.rule_id,
    approvalId: r.approval_id,
    event: r.event,
    actor: r.actor,
    createdAt: r.created_at,
  }));
}
