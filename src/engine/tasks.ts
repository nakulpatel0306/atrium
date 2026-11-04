import type { Database } from "bun:sqlite";
import { bus } from "./events";
import { newId } from "./ids";

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

const ALLOWED: Record<TaskStatus, TaskStatus[]> = {
  queued: ["running", "blocked"],
  running: ["review", "failed", "blocked", "queued"],
  review: ["done", "queued"],
  blocked: ["queued"],
  failed: ["queued"],
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
  branch: r.branch,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

function getTask(db: Database, id: string): Task | null {
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
    agent?: string;
  },
): Task {
  const id = newId("tsk");
  const now = Date.now();
  db.query(
    "INSERT INTO tasks (id, space_id, title, detail, agent, weight, allow_on_battery, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    input.spaceId,
    input.title,
    input.detail ?? "",
    input.agent ?? "claude",
    input.weight ?? "heavy",
    input.allowOnBattery ? 1 : 0,
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
