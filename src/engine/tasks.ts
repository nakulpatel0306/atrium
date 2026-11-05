import type { Database } from "bun:sqlite";
import { bus } from "./events";
import { newId } from "./ids";

export type TaskStatus = "queued" | "running" | "review" | "done" | "failed" | "blocked";

export type TaskPurpose = "digest" | "thesis_draft" | "thesis_check";

export type Task = {
  id: string;
  spaceId: string;
  title: string;
  detail: string;
  status: TaskStatus;
  blockedReason: string | null;
  agent: string;
  weight: "heavy" | "light";
  allowOnBattery: boolean;
  ignoreReserve: boolean;
  kind: "work" | "review" | "fix";
  parentTaskId: string | null;
  approvalId: string | null;
  // The approved paper strategy this task runs; null for everything else.
  strategyId: string | null;
  // What an investing task writes (a digest or thesis write-up) and the instrument it's about; null otherwise.
  purpose: TaskPurpose | null;
  subject: string | null;
  branch: string | null;
  createdAt: number;
  updatedAt: number;
};

type TaskRow = {
  id: string;
  space_id: string;
  title: string;
  detail: string;
  status: TaskStatus;
  blocked_reason: string | null;
  agent: string;
  weight: Task["weight"];
  allow_on_battery: number;
  ignore_reserve: number;
  kind: Task["kind"];
  parent_task_id: string | null;
  approval_id: string | null;
  strategy_id: string | null;
  purpose: TaskPurpose | null;
  subject: string | null;
  branch: string | null;
  created_at: number;
  updated_at: number;
};

export class InvalidTransition extends Error {
  constructor(from: TaskStatus, to: TaskStatus) {
    super(`A task can't move from ${from} to ${to}.`);
    this.name = "InvalidTransition";
  }
}

// A review or fix task finishes straight to done (its parent's approval covers it), and is
// cancelled to done from any unfinished state once Nakul decides on the parent.
const ALLOWED: Record<TaskStatus, TaskStatus[]> = {
  queued: ["running", "blocked", "done"],
  running: ["review", "failed", "blocked", "queued", "done"],
  review: ["done", "queued"],
  blocked: ["queued", "done"],
  failed: ["queued", "done"],
  done: [],
};

const toTask = (r: TaskRow): Task => ({
  id: r.id,
  spaceId: r.space_id,
  title: r.title,
  detail: r.detail,
  status: r.status,
  blockedReason: r.blocked_reason,
  agent: r.agent,
  weight: r.weight,
  allowOnBattery: r.allow_on_battery === 1,
  ignoreReserve: r.ignore_reserve === 1,
  kind: r.kind,
  parentTaskId: r.parent_task_id,
  approvalId: r.approval_id,
  strategyId: r.strategy_id,
  purpose: r.purpose ?? null,
  subject: r.subject ?? null,
  branch: r.branch,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function getTask(db: Database, id: string): Task | null {
  const row = db.query("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | null;
  return row ? toTask(row) : null;
}

export function createTask(
  db: Database,
  input: {
    spaceId: string;
    title: string;
    detail?: string;
    weight?: Task["weight"];
    allowOnBattery?: boolean;
    ignoreReserve?: boolean;
    kind?: Task["kind"];
    parentTaskId?: string;
    approvalId?: string;
    strategyId?: string;
    agent?: string;
    purpose?: TaskPurpose;
    subject?: string;
  },
): Task {
  const id = newId("tsk");
  const now = Date.now();
  db.query(
    "INSERT INTO tasks (id, space_id, title, detail, agent, weight, allow_on_battery, ignore_reserve, kind, parent_task_id, approval_id, strategy_id, purpose, subject, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    input.spaceId,
    input.title,
    input.detail ?? "",
    input.agent ?? "auto",
    input.weight ?? "heavy",
    input.allowOnBattery ? 1 : 0,
    input.ignoreReserve ? 1 : 0,
    input.kind ?? "work",
    input.parentTaskId ?? null,
    input.approvalId ?? null,
    input.strategyId ?? null,
    input.purpose ?? null,
    input.subject ?? null,
    now,
    now,
  );
  bus.emit({ type: "changed" });
  return getTask(db, id)!;
}

export function listTasks(db: Database, filter: { spaceId?: string; status?: TaskStatus[] } = {}): Task[] {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.spaceId) {
    where.push("space_id = ?");
    params.push(filter.spaceId);
  }
  if (filter.status?.length) {
    where.push(`status IN (${filter.status.map(() => "?").join(",")})`);
    params.push(...filter.status);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db.query(`SELECT * FROM tasks ${clause} ORDER BY created_at, rowid`).all(...params) as TaskRow[];
  return rows.map(toTask);
}

export function setTaskStatus(
  db: Database,
  id: string,
  status: TaskStatus,
  extra: { blockedReason?: string | null; branch?: string } = {},
): Task {
  const cur = getTask(db, id);
  if (!cur) throw new Error(`No task with id ${id}`);
  if (!ALLOWED[cur.status].includes(status)) throw new InvalidTransition(cur.status, status);
  // A reason only makes sense while blocked; any other status clears it.
  const reason = status === "blocked" ? (extra.blockedReason ?? null) : null;
  db.query("UPDATE tasks SET status = ?, blocked_reason = ?, branch = ?, updated_at = ? WHERE id = ?").run(
    status,
    reason,
    extra.branch ?? cur.branch,
    Date.now(),
    id,
  );
  bus.emit({ type: "changed" });
  return getTask(db, id)!;
}

export function appendTaskDetail(db: Database, id: string, text: string): Task {
  const cur = getTask(db, id);
  if (!cur) throw new Error(`No task with id ${id}`);
  db.query("UPDATE tasks SET detail = ?, updated_at = ? WHERE id = ?").run(cur.detail + text, Date.now(), id);
  bus.emit({ type: "changed" });
  return getTask(db, id)!;
}

// Undoing an automatic approval is the one way back from done. It is kept out of ALLOWED so nothing else can
// reopen a finished task, and guarded in SQL so it can't reopen anything but finished work.
export function reopenForReview(db: Database, id: string): Task {
  const res = db
    .query("UPDATE tasks SET status = 'review', updated_at = ? WHERE id = ? AND status = 'done' AND kind = 'work'")
    .run(Date.now(), id);
  if (res.changes === 0) {
    const cur = getTask(db, id);
    if (!cur) throw new Error(`No task with id ${id}`);
    throw new InvalidTransition("done", "review");
  }
  bus.emit({ type: "changed" });
  return getTask(db, id)!;
}
