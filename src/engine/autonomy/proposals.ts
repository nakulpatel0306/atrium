import type { Database } from "bun:sqlite";
import { getApproval } from "../approvals";
import { bus } from "../events";
import { newId } from "../ids";
import { labelOf, parseFingerprint, STREAK, STREAK_WINDOW_MS } from "./kinds";
import { activeRuleFor, createRule, logRuleEvent, type Rule, RuleRefused } from "./rules";

export type Proposal = {
  id: string;
  spaceId: string;
  fingerprint: string;
  label: string;
  evidence: { id: string; title: string; resolvedAt: number }[];
  status: "pending" | "yes" | "not_now" | "never";
  createdAt: number;
  answeredAt: number | null;
  liftedAt: number | null;
};

type ProposalRow = {
  id: string;
  space_id: string;
  fingerprint: string;
  evidence: string;
  status: Proposal["status"];
  created_at: number;
  answered_at: number | null;
  lifted_at: number | null;
};

function toProposal(db: Database, r: ProposalRow): Proposal {
  const ids = JSON.parse(r.evidence) as string[];
  return {
    id: r.id,
    spaceId: r.space_id,
    fingerprint: r.fingerprint,
    label: labelOf(r.fingerprint),
    evidence: ids.flatMap((id) => {
      const a = getApproval(db, id);
      return a ? [{ id, title: a.title, resolvedAt: a.resolvedAt ?? 0 }] : [];
    }),
    status: r.status,
    createdAt: r.created_at,
    answeredAt: r.answered_at,
    liftedAt: r.lifted_at,
  };
}

export function getProposal(db: Database, id: string): Proposal | null {
  const row = db.query("SELECT * FROM autonomy_proposals WHERE id = ?").get(id) as ProposalRow | null;
  return row ? toProposal(db, row) : null;
}

// "Unedited" for code review, where there's no draft to edit: Nakul approved it as it was, with nothing to
// add, first time round, and no reviewer had to send it for a fix.
const CLEAN = `a.decided_by = 'you' AND a.status = 'approved' AND COALESCE(a.note, '') = ''
  AND NOT EXISTS (SELECT 1 FROM approvals b WHERE b.task_id = a.task_id AND b.status = 'rejected')
  AND NOT EXISTS (SELECT 1 FROM tasks f WHERE f.parent_task_id = a.task_id AND f.kind = 'fix')`;

// The approval ids of the current run of clean approvals, newest first. Automatic approvals neither count
// nor break it; anything else Nakul decided (a send-back, a note, an undone automatic approval) ends it. Only
// approvals after his last answer about this kind count, so "Not now" and "Suggest again" start over.
export function cleanStreak(db: Database, spaceId: string, fingerprint: string, now = Date.now()): string[] {
  const answered = db
    .query(
      `SELECT MAX(COALESCE(CASE WHEN status IN ('not_now','yes') THEN answered_at END, 0), COALESCE(lifted_at, 0)) AS t
       FROM autonomy_proposals WHERE space_id = ? AND fingerprint = ? ORDER BY t DESC LIMIT 1`,
    )
    .get(spaceId, fingerprint) as { t: number } | null;
  const since = Math.max(now - STREAK_WINDOW_MS, answered?.t ?? 0);
  const rows = db
    .query(
      `SELECT a.id, a.decided_by, a.undone_at, (${CLEAN}) AS clean FROM approvals a
       WHERE a.space_id = ? AND a.fingerprint = ? AND a.status != 'pending' AND a.resolved_at > ?
       ORDER BY a.resolved_at DESC, a.rowid DESC`,
    )
    .all(spaceId, fingerprint, since) as { id: string; decided_by: string; undone_at: number | null; clean: number }[];
  const streak: string[] = [];
  for (const r of rows) {
    if (r.decided_by === "rule" && r.undone_at === null) continue;
    if (!r.clean) break;
    streak.push(r.id);
  }
  return streak;
}

// Called after Nakul decides an approval. Asks once the same kind has been approved cleanly STREAK times in a
// row, and never while he already has a rule, an open question, or a "never" for it.
export function considerProposal(db: Database, approvalId: string, now = Date.now()): Proposal | null {
  const made = db.transaction((): string | null => {
    const a = getApproval(db, approvalId);
    if (!a || a.status !== "approved" || a.decidedBy !== "you" || !a.fingerprint) return null;
    if (!parseFingerprint(a.fingerprint) || activeRuleFor(db, a.spaceId, a.fingerprint, now)) return null;
    const open = db
      .query(
        `SELECT 1 FROM autonomy_proposals WHERE space_id = ? AND fingerprint = ?
         AND (status = 'pending' OR (status = 'never' AND lifted_at IS NULL))`,
      )
      .get(a.spaceId, a.fingerprint);
    if (open) return null;
    const streak = cleanStreak(db, a.spaceId, a.fingerprint, now);
    if (streak.length < STREAK) return null;
    const id = newId("prp");
    db.query("INSERT INTO autonomy_proposals (id, space_id, fingerprint, evidence, created_at) VALUES (?, ?, ?, ?, ?)").run(
      id,
      a.spaceId,
      a.fingerprint,
      JSON.stringify(streak.slice(0, STREAK)),
      now,
    );
    logRuleEvent(db, { spaceId: a.spaceId, event: "proposed", actor: "atrium", proposalId: id }, now);
    return id;
  })();
  if (!made) return null;
  bus.emit({ type: "changed" });
  return getProposal(db, made);
}

export function answerProposal(
  db: Database,
  id: string,
  answer: "yes" | "not_now" | "never",
  now = Date.now(),
): { proposal: Proposal; rule: Rule | null } {
  const rule = db.transaction((): Rule | null => {
    const p = getProposal(db, id);
    if (!p) throw new RuleRefused("No such suggestion.");
    if (p.status !== "pending") throw new RuleRefused("This suggestion was already answered.");
    db.query("UPDATE autonomy_proposals SET status = ?, answered_at = ? WHERE id = ?").run(answer, now, id);
    logRuleEvent(db, { spaceId: p.spaceId, event: answer, actor: "you", proposalId: id }, now);
    return answer === "yes" ? createRule(db, id, now) : null;
  })();
  bus.emit({ type: "changed" });
  return { proposal: getProposal(db, id)!, rule };
}

export function suggestAgain(db: Database, id: string, now = Date.now()): Proposal {
  db.transaction(() => {
    const p = getProposal(db, id);
    if (!p) throw new RuleRefused("No such suggestion.");
    if (p.status !== "never" || p.liftedAt !== null) throw new RuleRefused("Atrium already suggests this when it fits.");
    db.query("UPDATE autonomy_proposals SET lifted_at = ? WHERE id = ?").run(now, id);
    logRuleEvent(db, { spaceId: p.spaceId, event: "suggest_again", actor: "you", proposalId: id }, now);
  })();
  bus.emit({ type: "changed" });
  return getProposal(db, id)!;
}

export function listPendingProposals(db: Database): Proposal[] {
  const rows = db.query("SELECT * FROM autonomy_proposals WHERE status = 'pending' ORDER BY created_at DESC, rowid DESC").all() as ProposalRow[];
  return rows.map((r) => toProposal(db, r));
}

export function listNeverProposals(db: Database): Proposal[] {
  const rows = db
    .query("SELECT * FROM autonomy_proposals WHERE status = 'never' AND lifted_at IS NULL ORDER BY answered_at DESC, rowid DESC")
    .all() as ProposalRow[];
  return rows.map((r) => toProposal(db, r));
}
