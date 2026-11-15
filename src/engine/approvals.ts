import type { Database } from "bun:sqlite";
import { bus, logActivity } from "./events";
import { newId } from "./ids";
import { branchHeadSync } from "./git";
import { getSpace } from "./spaces";
import { resumed } from "./loop";
import { batchApprovable, HELD_ASKS } from "./needs";
import { appendTaskDetail, getTask, listTasks, reopenForReview, setTaskLoop, setTaskStatus } from "./tasks";

export const ALWAYS_ASK = [
  "merge_main",
  "deploy",
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
  kind: "review" | "question";
  title: string;
  detail: string;
  status: "pending" | "approved" | "rejected";
  note: string | null;
  // The task branch's commit at the moment the user decided; null for non-repo work.
  branchHead: string | null;
  // The action kind the engine saw (see autonomy/kinds.ts); null when no rule could ever cover it.
  fingerprint: string | null;
  decidedBy: "you" | "rule";
  ruleId: string | null;
  undoneAt: number | null;
  // Set when only the user may ever decide this; no rule, proposal or auto-approval can.
  alwaysAsk: AlwaysAsk | null;
  createdAt: number;
  resolvedAt: number | null;
};

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
  always_ask: AlwaysAsk | null;
  created_at: number;
  resolved_at: number | null;
};

// The branch moved after the user looked: the approval would bind to a commit nobody saw.
export class HeadMoved extends Error {
  constructor() {
    super("The branch has changed since you looked, so nothing was approved. Look at it again, then decide.");
    this.name = "HeadMoved";
  }
}

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
  },
): Approval {
  if (input.alwaysAsk && input.fingerprint) throw new Error("An always-ask approval can't carry a fingerprint.");
  if (input.spaceId === null && input.kind !== "question") throw new Error("Only a question can belong to no space.");
  const id = newId("apr");
  db.query(
    "INSERT INTO approvals (id, space_id, task_id, kind, title, detail, fingerprint, always_ask, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    input.spaceId,
    input.taskId ?? null,
    input.kind,
    input.title,
    input.detail,
    input.fingerprint ?? null,
    input.alwaysAsk ?? null,
    Date.now(),
  );
  bus.emit({ type: "changed" });
  return getApproval(db, id)!;
}

// Only a pending approval grows: once the user has decided, what they decided on stays as it was.
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

export function listPending(db: Database): Approval[] {
  // rowid breaks ties between approvals created in the same millisecond. Alerts, texts and the other kinds an older
  // database holds from features Atrium no longer has can't be acted on, so they aren't listed.
  const rows = db
    .query(`SELECT * FROM approvals WHERE status = 'pending' AND kind IN ('review','question') AND (always_ask IS NULL OR always_ask IN (${ALWAYS_ASK.map((k) => `'${k}'`).join(",")})) ORDER BY created_at DESC, rowid DESC`)
    .all() as ApprovalRow[];
  return rows.map(toApproval);
}

function taskBranchHead(db: Database, taskId: string | null): string | null {
  const task = taskId ? getTask(db, taskId) : null;
  const path = task?.branch ? getSpace(db, task.spaceId)?.repoPath : null;
  return path && task?.branch ? branchHeadSync(path, task.branch) : null;
}

// With `rule`, one of the user's rules is deciding in their place, and a rule can only ever approve. Its `head` is the
// commit the rule checked, recorded as what was approved. With `atHead`, the user approved the commit the page showed:
// the branch is read again inside the decision and, if it moved, nothing is decided (HeadMoved); otherwise exactly that
// commit is what's recorded.
export function resolveApproval(
  db: Database,
  id: string,
  decision: "approve" | "reject",
  note?: string,
  rule?: { id: string; label: string; head?: string },
  opts: { atHead?: string } = {},
): Approval {
  if (rule && decision !== "approve") throw new Error("A rule can only approve.");
  if (rule && getApproval(db, id)?.alwaysAsk) throw new Error(RULE_NEVER_DECIDES);
  const resolve = db.transaction((): Approval => {
    const head = rule?.head ?? taskBranchHead(db, getApproval(db, id)?.taskId ?? null);
    if (opts.atHead !== undefined && head !== opts.atHead) throw new HeadMoved();
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
        // Sent back by the user: a new attempt, with its own review rounds and budget.
        const loop = getTask(db, a.taskId)?.loop;
        if (loop) setTaskLoop(db, a.taskId, { ...resumed(loop), reviews: [], reviewedSha: null, triaged: false, report: [], staleRetried: false });
      }
      // A review still waiting would only second-guess a decision the user has made.
      const parentId = a.taskId;
      for (const child of listTasks(db, { status: ["queued", "running", "blocked", "failed"] })) {
        if (child.parentTaskId !== parentId) continue;
        setTaskStatus(db, child.id, "done");
        logActivity(db, a.spaceId, "atrium", `Skipped: you already decided. ${child.title}`, { taskId: child.id });
      }
    }
    if (rule) logActivity(db, a.spaceId, "atrium", `Approved by your rule "${rule.label}": ${a.title}`, { taskId: a.taskId });
    else logActivity(db, a.spaceId, "you", decisionLine(db, a, decision), { taskId: a.taskId });
    return a;
  });
  const a = resolve();
  // Listeners act on the decision (a repo push), so they wait until it's committed. Inside a caller's transaction
  // (the new-project route saves the draft's edits and the yes together) they run once that transaction has
  // finished, and only if the decision is still there; a rolled-back yes runs nothing.
  const fire = () => {
    if (db.inTransaction) return queueMicrotask(fire);
    let current: Approval | null;
    try {
      current = getApproval(db, a.id);
    } catch {
      return;
    }
    if (current?.status !== a.status) return;
    for (const fn of [...resolvedListeners]) {
      try {
        fn(a, decision);
      } catch (e) {
        console.error(`An approval listener failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };
  fire();
  bus.emit({ type: "changed" });
  return a;
}

// Accepting a result the agent said it didn't finish is recorded as exactly that.
function decisionLine(db: Database, a: Approval, decision: "approve" | "reject"): string {
  if (decision === "reject") return `Rejected: ${a.title}`;
  const outcome = a.kind === "review" && a.taskId ? getTask(db, a.taskId)?.outcome : null;
  if (outcome === "couldnt") return `Accepted anyway: ${a.title}. It says it couldn't do this.`;
  if (outcome === "partial") return `Accepted as is: ${a.title}. It says it's only partly done.`;
  return `Approved: ${a.title}`;
}

// The user said yes and hasn't undone it: the only decision that may run a repo action.
export const isOwnYes = (a: Approval): boolean =>
  a.status === "approved" && a.decidedBy === "you" && a.ruleId === null && a.undoneAt === null;

const resolvedListeners = new Set<(a: Approval, decision: "approve" | "reject") => void>();

// Runs after the decision is committed, so a listener sees the final state and can't undo the decision by throwing.
export function onApprovalResolved(fn: (a: Approval, decision: "approve" | "reject") => void): () => void {
  resolvedListeners.add(fn);
  return () => resolvedListeners.delete(fn);
}

// The most a batch may name at once; the page never shows more than this many clean results together.
export const BATCH_MAX = 200;

// Approves several results in one go, each only if it's clean by the one rule (needs.ts) as the database has it now,
// and only at the commit the page showed: that commit must still be the branch's head and what the checks and the
// reviewer read. Anything else is left waiting, with why. `beforeResolve` is a test seam for a branch moving in
// between.
export function approveClean(
  db: Database,
  items: readonly { id: string; sha: string }[],
  seams: { beforeResolve?: (id: string) => void } = {},
): { approved: string[]; skipped: { id: string; reason: string }[] } {
  const approved: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const { id, sha } of items.slice(0, BATCH_MAX)) {
    const a = getApproval(db, id);
    if (!a) {
      skipped.push({ id, reason: "No such approval." });
      continue;
    }
    if (a.status !== "pending") {
      skipped.push({ id, reason: "It was already decided." });
      continue;
    }
    const task = a.taskId ? getTask(db, a.taskId) : null;
    if (!batchApprovable(a, task ?? undefined)) {
      skipped.push({ id, reason: "It has something to read on its own first: a note, a check that didn't pass, or a finding that wasn't fixed." });
      continue;
    }
    const head = taskBranchHead(db, a.taskId);
    if (!head || head !== sha || task!.loop!.checkedSha !== sha || task!.loop!.reviewedSha !== sha) {
      skipped.push({ id, reason: "Its branch changed since it was checked, reviewed or shown, so it needs another look." });
      continue;
    }
    seams.beforeResolve?.(id);
    try {
      resolveApproval(db, id, "approve", undefined, undefined, { atHead: sha });
    } catch (e) {
      if (!(e instanceof HeadMoved)) throw e;
      skipped.push({ id, reason: "Its branch changed since it was checked, reviewed or shown, so it needs another look." });
      continue;
    }
    approved.push(id);
  }
  return { approved, skipped };
}

// How long after approving the user can take it back from the toast; past this, ask for a new task. A new repo or a
// local copy's removal waits this long after the yes before it starts, so its Undo is real.
export const UNDO_MS = 60_000;

// Yeses to a new repo or a removal still in their hold: shown in Needs you as starting soon, with an Undo, so one that
// resumed after a restart can be taken back even though its toast is gone.
export type Held = { id: string; spaceId: string | null; title: string; approvedAt: number; startsAt: number };
export function listHeld(db: Database): Held[] {
  const rows = db
    .query(
      `SELECT a.id, a.space_id AS spaceId, a.title, a.resolved_at AS approvedAt FROM repo_actions r JOIN approvals a ON a.id = r.approval_id
       WHERE r.status = 'draft' AND a.status = 'approved' AND a.undone_at IS NULL ORDER BY a.resolved_at`,
    )
    .all() as Omit<Held, "startsAt">[];
  return rows.map((r) => ({ ...r, startsAt: r.approvedAt + UNDO_MS }));
}

// Takes back a yes to a new repo or a removal that hasn't started: the ask is pending again, under a fresh approval
// its repo action now points to, so the held start finds no yes and does nothing.
function reopenHeldAsk(db: Database, a: Approval, now: number): Approval {
  if (a.status !== "approved" || a.decidedBy !== "you") throw new Error("Only an approval you just gave can be taken back.");
  if (a.undoneAt !== null) throw new Error("This approval was already taken back.");
  if (now - (a.resolvedAt ?? 0) > UNDO_MS) throw new Error("This was approved too long ago to take back.");
  const action = db.query("SELECT id, status FROM repo_actions WHERE approval_id = ?").get(a.id) as { id: string; status: string } | null;
  if (!action || action.status !== "draft") throw new Error("This has already started, so it can't be taken back.");
  db.query("UPDATE approvals SET undone_at = ? WHERE id = ?").run(now, a.id);
  const fresh = createApproval(db, { spaceId: a.spaceId, taskId: a.taskId ?? undefined, kind: a.kind, title: a.title, detail: a.detail, fingerprint: a.fingerprint ?? undefined, alwaysAsk: a.alwaysAsk ?? undefined });
  db.query("UPDATE repo_actions SET approval_id = ?, updated_at = ? WHERE id = ?").run(fresh.id, now, action.id);
  return fresh;
}

// Takes back the user's own approval of a result a moment ago: the task goes back to review with a fresh approval,
// as long as nothing has left the Mac since (no push or pull request started for it) and nothing else happened to it.
export function reopenDecision(db: Database, id: string, now = Date.now()): Approval {
  const reopened = db.transaction((): Approval => {
    const a = getApproval(db, id);
    if (a && a.kind === "question" && a.alwaysAsk && HELD_ASKS.includes(a.alwaysAsk)) return reopenHeldAsk(db, a, now);
    if (!a || a.kind !== "review" || a.status !== "approved" || a.decidedBy !== "you" || !a.taskId || !a.spaceId) throw new Error("Only an approval you just gave a result can be taken back.");
    if (a.undoneAt !== null) throw new Error("This approval was already taken back.");
    if (now - (a.resolvedAt ?? 0) > UNDO_MS) throw new Error("This was approved too long ago to take back. Ask for the change again as a new task.");
    const task = getTask(db, a.taskId);
    // The push's own approval is recorded before anything is sent, so a push still in flight counts too.
    const pushed = db.query("SELECT 1 FROM approvals WHERE task_id = ? AND always_ask = 'push' AND created_at >= ?").get(a.taskId, a.resolvedAt ?? 0);
    if (task?.prUrl || pushed) throw new Error("This result has already left your Mac (a push or pull request started), so it can't go back to review.");
    if (task?.status !== "done" || task.kind !== "work") throw new Error("This task changed after it was approved, so it can't go back to review.");
    db.query("UPDATE approvals SET undone_at = ? WHERE id = ?").run(now, a.id);
    reopenForReview(db, task.id);
    return createApproval(db, { spaceId: a.spaceId, taskId: task.id, kind: a.kind, title: a.title, detail: a.detail, fingerprint: a.fingerprint });
  })();
  logActivity(db, reopened.spaceId, "you", `Took back the approval: ${reopened.title}`, { taskId: reopened.taskId });
  bus.emit({ type: "changed" });
  return reopened;
}
