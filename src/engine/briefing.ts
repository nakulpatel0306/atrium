import type { Database } from "bun:sqlite";
import { listPending } from "./approvals";
import { getSetting, setSetting } from "./settings";
import { listTasks } from "./tasks";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function greetingFor(now: number): string {
  const hour = new Date(now).getHours();
  const part = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  return `Good ${part}, Nakul.`;
}

export function briefing(db: Database, now: number): { greeting: string; summary: string } {
  const lastSeen = Number(getSetting(db, "lastSeen") ?? 0);
  const ended = db
    .query(
      `SELECT r.exit_code AS exit_code, t.space_id AS space_id FROM runs r JOIN tasks t ON t.id = r.task_id
       WHERE r.ended_at IS NOT NULL AND r.ended_at > ?`,
    )
    .all(lastSeen) as { exit_code: number; space_id: string }[];
  const finished = ended.filter((r) => r.exit_code === 0);
  const spaces = new Set(finished.map((r) => r.space_id)).size;

  const parts: string[] = [];
  if (finished.length > 0) {
    parts.push(`${plural(finished.length, "task", "tasks")} finished across ${plural(spaces, "space", "spaces")}`);
  } else if (ended.length === 0) {
    parts.push("Nothing ran since you were last here");
  }

  const pending = listPending(db).length;
  if (pending > 0) parts.push(`${pending} ${pending === 1 ? "thing needs" : "things need"} you`);

  const blocked = listTasks(db, { status: ["blocked"] });
  if (blocked.length > 0) {
    const reason = blocked[0]!.blockedReason;
    parts.push(`${blocked.length} blocked${reason ? ` (${reason})` : ""}`);
  }

  if (getSetting(db, "runner.waiting")) parts.push("Heavy work is waiting for power");

  return { greeting: greetingFor(now), summary: `${parts.join(". ")}.` };
}

export function markSeen(db: Database, now: number): void {
  setSetting(db, "lastSeen", String(now));
}
