import type { Database } from "bun:sqlite";
import { bus } from "./events";
import { newId } from "./ids";
import { type Brief, normalizeBrief } from "./brief";
import { type LoopState, newLoop, SIZE_BUDGETS } from "./loop";
import type { Outcome } from "./outcome";

export type TaskStatus = "queued" | "running" | "review" | "done" | "failed" | "blocked";

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
  // The purpose an older Atrium gave the task (digest, money, message…); no feature uses one now, so any value means
  // the task belongs to a feature that was removed and must not run. Null for every task made today.
  legacyPurpose: string | null;
  branch: string | null;
  // Whether the last finished run did what the title asks, in the agent's own words; null before outcomes existed
  // or while the task hasn't finished.
  outcome: Outcome | null;
  outcomeReason: string | null;
  // The pull request opened from this task's branch; null until one is.
  prUrl: string | null;
  // The structured brief it was started with; null for a one-line ask sent straight away.
  brief: Brief | null;
  // Where a coding task is in the loop; null before its first turn and for work outside a repo.
  loop: LoopState | null;
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
  purpose?: string | null;
  branch: string | null;
  outcome: Outcome | null;
  outcome_reason: string | null;
  pr_url: string | null;
  brief: string | null;
  loop: string | null;
  created_at: number;
  updated_at: number;
};

export class InvalidTransition extends Error {
  constructor(from: TaskStatus, to: TaskStatus) {
    super(`A task can't move from ${from} to ${to}.`);
    this.name = "InvalidTransition";
  }
}

// A review task finishes straight to done (its parent's approval covers it), and is cancelled to done from any
// unfinished state once the user decides on the parent. A work task waits in the queue while its review runs, and
// goes from there to waiting for him.
const ALLOWED: Record<TaskStatus, TaskStatus[]> = {
  queued: ["running", "blocked", "review", "done"],
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
  legacyPurpose: r.purpose ?? null,
  branch: r.branch,
  outcome: r.outcome ?? null,
  outcomeReason: r.outcome_reason ?? null,
  prUrl: r.pr_url ?? null,
  brief: r.brief ? normalizeBrief(JSON.parse(r.brief)) : null,
  // Over the defaults, so a row from an older engine, missing a field the gate reads, reads as that field's
  // strictest value rather than as undefined.
  loop: r.loop ? { ...newLoop(SIZE_BUDGETS.medium), ...(JSON.parse(r.loop) as Partial<LoopState>) } : null,
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
    agent?: string;
    brief?: Brief;
  },
): Task {
  const id = newId("tsk");
  const now = Date.now();
  db.query(
    "INSERT INTO tasks (id, space_id, title, detail, agent, weight, allow_on_battery, ignore_reserve, kind, parent_task_id, approval_id, brief, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
    input.brief ? JSON.stringify(input.brief) : null,
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

// Not tied to status: a result Nakul accepts stays labelled with what the agent said about it.
export function setTaskOutcome(db: Database, id: string, outcome: Outcome, reason: string | null): Task {
  const res = db.query("UPDATE tasks SET outcome = ?, outcome_reason = ?, updated_at = ? WHERE id = ?").run(outcome, reason, Date.now(), id);
  if (res.changes === 0) throw new Error(`No task with id ${id}`);
  bus.emit({ type: "changed" });
  return getTask(db, id)!;
}

export function setTaskLoop(db: Database, id: string, loop: LoopState | null): Task {
  const res = db.query("UPDATE tasks SET loop = ?, updated_at = ? WHERE id = ?").run(loop ? JSON.stringify(loop) : null, Date.now(), id);
  if (res.changes === 0) throw new Error(`No task with id ${id}`);
  bus.emit({ type: "changed" });
  return getTask(db, id)!;
}

export function setTaskBrief(db: Database, id: string, brief: Brief): Task {
  const res = db.query("UPDATE tasks SET brief = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(brief), Date.now(), id);
  if (res.changes === 0) throw new Error(`No task with id ${id}`);
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

export const REMOVED_FEATURE = "This feature was removed from Atrium, so the task didn't run.";

// Ends a task of a removed feature as failed with a plain note. A waiting or blocked task passes through running, the
// only way the status rules reach failed; nothing runs in between.
export function failRemovedFeatureTask(db: Database, id: string): void {
  if (getTask(db, id)?.status === "blocked") setTaskStatus(db, id, "queued");
  if (getTask(db, id)?.status === "queued") setTaskStatus(db, id, "running");
  setTaskStatus(db, id, "failed");
  // Only a blocked task keeps a reason through setTaskStatus; this one is kept for the note the user reads.
  db.query("UPDATE tasks SET blocked_reason = ? WHERE id = ?").run(REMOVED_FEATURE, id);
}

// Tasks an older Atrium made for features that are gone (their `purpose` column is still in the database). One that
// is waiting, blocked or running is ended with a plain note instead of being run; the rows themselves are kept.
export function endRemovedFeatureTasks(db: Database): number {
  const cols = db.query("PRAGMA table_info(tasks)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "purpose")) return 0;
  const ids = (db.query("SELECT id FROM tasks WHERE purpose IS NOT NULL AND status IN ('queued','running','blocked')").all() as { id: string }[]).map((r) => r.id);
  for (const id of ids) failRemovedFeatureTask(db, id);
  return ids.length;
}
