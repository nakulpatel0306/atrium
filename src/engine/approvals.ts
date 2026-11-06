import type { Database } from "bun:sqlite";
import { bus, logActivity } from "./events";
import { newId } from "./ids";
import { branchHeadSync } from "./git";
import { getSpace } from "./spaces";
import { appendTaskDetail, getTask, listTasks, setTaskStatus } from "./tasks";

export const ALWAYS_ASK = [
  "merge_main",
  "deploy",
  "first_contact",
  "delete",
  "spend",
  "secrets",
  "create_repo",
  "push",
  "remove_clone",
] as const;
export type AlwaysAsk = (typeof ALWAYS_ASK)[number];

export const RULE_NEVER_DECIDES = "A rule can never decide this. It always waits for you.";

export type Approval = {
  id: string;
  // Null only for Atrium-wide questions, such as creating a GitHub repo.
  spaceId: string | null;
  taskId: string | null;
  kind: "review" | "question" | "alert";
  title: string;
  detail: string;
  status: "pending" | "approved" | "rejected";
  note: string | null;
  // The task branch's commit at the moment Nakul decided; null for non-repo work.
  branchHead: string | null;
  // The action kind the engine saw (see autonomy/kinds.ts); null when no rule could ever cover it.
  fingerprint: string | null;
  decidedBy: "you" | "rule";
  ruleId: string | null;
  undoneAt: number | null;
  // The kind of market alert; null for everything else.
  topic: AlertTopic | null;
  // The instrument an alert or flag is about ("AMZN"); null for everything else.
  subject: string | null;
  // Set when only Nakul himself may ever decide this; no rule, proposal or auto-approval can.
  alwaysAsk: AlwaysAsk | null;
  createdAt: number;
  resolvedAt: number | null;
};

export type AlertTopic = "price" | "indicator" | "earnings" | "news" | "flag";

type ApprovalRow = {
  id: string;
  space_id: string | null;
  task_id: string | null;
  kind: Approval["kind"];
  title: string;
  detail: string;
  status: Approval["status"];
  note: string | null;
  branch_head: string | null;
  fingerprint: string | null;
  decided_by: Approval["decidedBy"];
  rule_id: string | null;
  undone_at: number | null;
  topic: AlertTopic | null;
  subject: string | null;
  always_ask: AlwaysAsk | null;
  created_at: number;
  resolved_at: number | null;
};

export class AlreadyResolved extends Error {
  constructor() {
    super("This item was already resolved. Refresh the Needs you list to see its current state.");
    this.name = "AlreadyResolved";
  }
}

const toApproval = (r: ApprovalRow): Approval => ({
  id: r.id,
  spaceId: r.space_id,
  taskId: r.task_id,
  kind: r.kind,
  title: r.title,
  detail: r.detail,
  status: r.status,
  note: r.note,
  branchHead: r.branch_head,
  fingerprint: r.fingerprint,
  decidedBy: r.decided_by,
  ruleId: r.rule_id,
  undoneAt: r.undone_at,
  topic: r.topic ?? null,
  subject: r.subject ?? null,
  alwaysAsk: r.always_ask,
  createdAt: r.created_at,
  resolvedAt: r.resolved_at,
});

export const getApproval = (db: Database, id: string): Approval | null => {
  const row = db.query("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow | null;
  return row ? toApproval(row) : null;
};

export function createApproval(
  db: Database,
  input: {
    spaceId: string | null;
    taskId?: string;
    kind: Approval["kind"];
    title: string;
    detail: string;
    fingerprint?: string | null;
    alwaysAsk?: AlwaysAsk;
    topic?: AlertTopic | null;
    subject?: string | null;
  },
): Approval {
  if (input.alwaysAsk && input.fingerprint) throw new Error("An always-ask approval can't carry a fingerprint.");
  if (input.spaceId === null && input.kind !== "question") throw new Error("Only a question can belong to no space.");
  const id = newId("apr");
  db.query(
    "INSERT INTO approvals (id, space_id, task_id, kind, title, detail, fingerprint, always_ask, topic, subject, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    input.spaceId,
    input.taskId ?? null,
    input.kind,
    input.title,
    input.detail,
    input.fingerprint ?? null,
    input.alwaysAsk ?? null,
    input.topic ?? null,
    input.subject ?? null,
    Date.now(),
  );
  bus.emit({ type: "changed" });
  return getApproval(db, id)!;
}

// Only a pending approval grows: once Nakul has decided, what he decided on stays as it was.
export function appendApprovalDetail(db: Database, id: string, text: string): void {
  db.query("UPDATE approvals SET detail = detail || ? WHERE id = ? AND status = 'pending'").run(text, id);
  bus.emit({ type: "changed" });
}

// Swaps one piece of a pending approval's text for another, or appends `text` when `old` isn't there. Guarded on
// the text read, so a change that lands in between isn't overwritten.
export function replaceApprovalDetail(db: Database, id: string, old: string | RegExp, text: string, appendIfMissing = true): void {
  const a = getApproval(db, id);
  if (a?.status !== "pending") return;
  const found = typeof old === "string" ? a.detail.includes(old) : old.test(a.detail);
  if (!found && !appendIfMissing) return;
  const next = found ? a.detail.replace(old, () => text) : a.detail + text;
  db.query("UPDATE approvals SET detail = ? WHERE id = ? AND status = 'pending' AND detail = ?").run(next, id, a.detail);
  bus.emit({ type: "changed" });
}

// After a late fix commit is moved off the branch, the recorded head goes back to what Nakul decided on;
// only if it recorded that late commit.
export function correctBranchHead(db: Database, id: string, from: string, to: string): void {
  db.query("UPDATE approvals SET branch_head = ? WHERE id = ? AND branch_head = ?").run(to, id, from);
}

export function listPending(db: Database): Approval[] {
  // rowid breaks ties between approvals created in the same millisecond
  const rows = db
    .query("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at DESC, rowid DESC")
    .all() as ApprovalRow[];
  return rows.map(toApproval);
}

function taskBranchHead(db: Database, taskId: string | null): string | null {
  const task = taskId ? getTask(db, taskId) : null;
  const path = task?.branch ? getSpace(db, task.spaceId)?.repoPath : null;
  return path && task?.branch ? branchHeadSync(path, task.branch) : null;
}

// With `rule`, one of Nakul's rules is deciding in his place, and a rule can only ever approve. Its `head` is the
// commit the rule checked, recorded as what was approved.
export function resolveApproval(
  db: Database,
  id: string,
  decision: "approve" | "reject",
  note?: string,
  rule?: { id: string; label: string; head?: string },
): Approval {
  if (rule && decision !== "approve") throw new Error("A rule can only approve.");
  if (rule && getApproval(db, id)?.alwaysAsk) throw new Error(RULE_NEVER_DECIDES);
  const head = rule?.head ?? taskBranchHead(db, getApproval(db, id)?.taskId ?? null);
  const resolve = db.transaction((): Approval => {
    const res = db
      .query(
        `UPDATE approvals SET status = ?, note = ?, branch_head = ?, resolved_at = ?, decided_by = ?, rule_id = ? WHERE id = ? AND status = 'pending'${rule ? " AND always_ask IS NULL" : ""}`,
      )
      .run(decision === "approve" ? "approved" : "rejected", note ?? null, head, Date.now(), rule ? "rule" : "you", rule?.id ?? null, id);
    if (res.changes === 0) {
      if (!getApproval(db, id)) throw new Error(`No approval with id ${id}`);
      throw new AlreadyResolved();
    }
    const a = getApproval(db, id)!;
    if (a.kind === "review" && a.taskId) {
      if (decision === "approve") {
        setTaskStatus(db, a.taskId, "done");
      } else {
        setTaskStatus(db, a.taskId, "queued");
        if (note) appendTaskDetail(db, a.taskId, `\n\nFeedback: ${note}`);
      }
      // A review or fix still waiting would only second-guess a decision Nakul has made.
      const parentId = a.taskId;
      for (const child of listTasks(db, { status: ["queued", "running", "blocked", "failed"] })) {
        if (child.parentTaskId !== parentId) continue;
        setTaskStatus(db, child.id, "done");
        logActivity(db, a.spaceId, "atrium", `Skipped: you already decided. ${child.title}`);
      }
    }
    if (rule) logActivity(db, a.spaceId, "atrium", `Approved by your rule "${rule.label}": ${a.title}`);
    else if (a.kind === "alert") logActivity(db, a.spaceId, "you", `Dismissed: ${a.title}`);
    else logActivity(db, a.spaceId, "you", `${decision === "approve" ? "Approved" : "Rejected"}: ${a.title}`);
    return a;
  });
  const a = resolve();
  for (const fn of [...resolvedListeners]) {
    try {
      fn(a, decision);
    } catch (e) {
      console.error(`An approval listener failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  bus.emit({ type: "changed" });
  return a;
}

// Nakul himself said yes and hasn't undone it: the only decision that may run a repo action.
export const isOwnYes = (a: Approval): boolean =>
  a.status === "approved" && a.decidedBy === "you" && a.ruleId === null && a.undoneAt === null;

const resolvedListeners = new Set<(a: Approval, decision: "approve" | "reject") => void>();

// Runs after the decision is committed, so a listener sees the final state and can't undo the decision by throwing.
export function onApprovalResolved(fn: (a: Approval, decision: "approve" | "reject") => void): () => void {
  resolvedListeners.add(fn);
  return () => resolvedListeners.delete(fn);
}
