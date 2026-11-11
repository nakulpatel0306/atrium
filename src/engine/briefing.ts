import type { Database } from "bun:sqlite";
import { type ActivityKind, activityKind } from "./activity-groups";
import { marketsBriefing, type MarketsBriefing } from "./markets/briefing";
import { plural } from "./text";
import { userName } from "./profile";
import { getSetting, setSetting } from "./settings";

function greetingFor(now: number, name: string | null): string {
  const hour = new Date(now).getHours();
  const part = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  return `Good ${part}${name ? `, ${name}` : ""}.`;
}

// The kinds of Activity line that mean a task's run came back with an answer, even "couldn't" (counted again below).
const FINISHED = new Set<ActivityKind>(["finished", "ready", "partial", "couldnt"]);

// Distinct tasks with a finished line since `since`, and how many spaces they span. Read from the same activity log
// the Activity feed shows, so the two can't disagree.
function finishedSince(db: Database, since: number): { tasks: number; spaces: number } {
  const rows = db.query("SELECT space_id, task_id, message FROM activity WHERE created_at > ?").all(since) as { space_id: string | null; task_id: string | null; message: string }[];
  const done = rows.filter((r) => FINISHED.has(activityKind(r.message)));
  return { tasks: new Set(done.map((r) => r.task_id ?? r.message)).size, spaces: new Set(done.map((r) => r.space_id)).size };
}

export function briefing(db: Database, now: number): { greeting: string; summary: string; markets: MarketsBriefing | null } {
  const lastSeen = Number(getSetting(db, "lastSeen") ?? 0);
  const since = finishedSince(db, lastSeen);
  const failed = db
    .query("SELECT COUNT(*) AS n FROM runs WHERE ended_at IS NOT NULL AND ended_at > ? AND exit_code != 0")
    .get(lastSeen) as { n: number };

  let summary: string;
  if (since.tasks > 0) {
    summary = `Since you were last here: ${since.tasks} finished${since.spaces > 1 ? ` across ${since.spaces} spaces` : ""}.`;
  } else if (failed.n > 0) {
    // Rate-limited requeues and crash recovery end runs without leaving a blocked task to report.
    summary = `${plural(failed.n, "run", "runs")} ended without finishing since you were last here.`;
  } else {
    // A reload counts as a visit, so say what today's feed already shows rather than a bare "nothing".
    const today = finishedSince(db, new Date(now).setHours(0, 0, 0, 0)).tasks;
    summary = today > 0 ? `Nothing new since you were last here. Today: ${today} finished.` : "Nothing ran since you were last here.";
  }

  const byRules = db
    .query("SELECT COUNT(*) AS n FROM approvals WHERE decided_by = 'rule' AND undone_at IS NULL AND resolved_at > ?")
    .get(lastSeen) as { n: number };
  if (byRules.n > 0) summary += ` ${plural(byRules.n, "result")} approved by your rules.`;

  const couldnt = db.query("SELECT COUNT(*) AS n FROM tasks WHERE outcome = 'couldnt' AND updated_at > ?").get(lastSeen) as { n: number };
  if (couldnt.n > 0) summary += ` ${couldnt.n} couldn't be done; open ${couldnt.n === 1 ? "it" : "them"} to see why.`;

  return { greeting: greetingFor(now, userName(db)), summary, markets: marketsBriefing(db, now) };
}

export function markSeen(db: Database, now: number): void {
  setSetting(db, "lastSeen", String(now));
}
