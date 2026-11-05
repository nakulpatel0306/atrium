import type { Database } from "bun:sqlite";
import { plural } from "./text";
import { getSetting, setSetting } from "./settings";

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

  let summary: string;
  if (finished.length > 0) {
    summary = `${plural(finished.length, "task", "tasks")} finished across ${plural(spaces, "space", "spaces")}.`;
  } else if (ended.length === 0) {
    summary = "Nothing ran since you were last here.";
  } else {
    // Rate-limited requeues and crash recovery end runs without leaving a blocked task to report.
    summary = `${plural(ended.length, "run", "runs")} ended without finishing since you were last here.`;
  }

  const byRules = db
    .query("SELECT COUNT(*) AS n FROM approvals WHERE decided_by = 'rule' AND resolved_at > ?")
    .get(lastSeen) as { n: number };
  if (byRules.n > 0) summary += ` ${plural(byRules.n, "result")} approved by your rules.`;

  return { greeting: greetingFor(now), summary };
}

export function markSeen(db: Database, now: number): void {
  setSetting(db, "lastSeen", String(now));
}
