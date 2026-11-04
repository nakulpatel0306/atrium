import type { Database } from "bun:sqlite";
import { bus, logActivity } from "./events";
import { newId } from "./ids";
import { appendTaskDetail, setTaskStatus } from "./tasks";

export const ALWAYS_ASK = ["merge_main", "deploy", "first_contact", "delete", "spend", "secrets"] as const;

export type Approval = {
  id: string;
  spaceId: string;
  taskId: string | null;
  kind: "review" | "question";
  title: string;
  detail: string;
  status: "pending" | "approved" | "rejected";
  note: string | null;
  createdAt: number;
  resolvedAt: number | null;
};

type ApprovalRow = {
  id: string;
  space_id: string;
  task_id: string | null;
  kind: Approval["kind"];
  title: string;
  detail: string;
  status: Approval["status"];
  note: string | null;
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
  createdAt: r.created_at,
  resolvedAt: r.resolved_at,
});

const getApproval = (db: Database, id: string): Approval | null => {
  const row = db.query("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow | null;
  return row ? toApproval(row) : null;
};

// Plan 6 adds configurable rules; ALWAYS_ASK stays true regardless of them.
export function requiresApproval(_action: string): boolean {
  return true;
}

export function createApproval(
  db: Database,
  input: { spaceId: string; taskId?: string; kind: Approval["kind"]; title: string; detail: string },
): Approval {
  const id = newId("apr");
  db.query(
    "INSERT INTO approvals (id, space_id, task_id, kind, title, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, input.spaceId, input.taskId ?? null, input.kind, input.title, input.detail, Date.now());
  bus.emit({ type: "changed" });
  return getApproval(db, id)!;
}

export function listPending(db: Database): Approval[] {
  // rowid breaks ties between approvals created in the same millisecond
  const rows = db
    .query("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at DESC, rowid DESC")
    .all() as ApprovalRow[];
  return rows.map(toApproval);
}

export function resolveApproval(db: Database, id: string, decision: "approve" | "reject", note?: string): Approval {
  const resolve = db.transaction((): Approval => {
    const res = db
      .query("UPDATE approvals SET status = ?, note = ?, resolved_at = ? WHERE id = ? AND status = 'pending'")
      .run(decision === "approve" ? "approved" : "rejected", note ?? null, Date.now(), id);
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
    }
    logActivity(db, a.spaceId, "you", `${decision === "approve" ? "Approved" : "Rejected"}: ${a.title}`);
    return a;
  });
  const a = resolve();
  bus.emit({ type: "changed" });
  return a;
}
