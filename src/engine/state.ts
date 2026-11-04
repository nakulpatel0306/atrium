import type { Database } from "bun:sqlite";
import { type Approval, listPending } from "./approvals";
import { briefing } from "./briefing";
import { type ActivityRow, listActivity } from "./events";
import { getSetting } from "./settings";
import { type Space, listSpaces } from "./spaces";
import { atriumDiskUsage } from "./storage";
import { type Task, listTasks } from "./tasks";

export type State = {
  spaces: Space[];
  tasks: Task[];
  approvals: Approval[];
  activity: ActivityRow[];
  briefing: ReturnType<typeof briefing>;
  power: {
    source: "ac" | "battery";
    overnight: boolean;
    keepAwake: boolean;
    waiting?: { taskId: string; reason: string };
    pausedUntil?: number;
  };
  usage: { claudeTokens24h: number };
  disk: ReturnType<typeof atriumDiskUsage>;
};

export function snapshot(db: Database): State {
  const now = Date.now();
  const waitingRaw = getSetting(db, "runner.waiting");
  const pausedUntil = Number(getSetting(db, "runner.pausedUntil") ?? 0);
  const tokens = db
    .query("SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS n FROM runs WHERE started_at > ?")
    .get(now - 24 * 3600_000) as { n: number };
  return {
    spaces: listSpaces(db),
    tasks: listTasks(db),
    approvals: listPending(db),
    activity: listActivity(db, { limit: 100 }),
    briefing: briefing(db, now),
    power: {
      source: getSetting(db, "power.source") === "battery" ? "battery" : "ac",
      overnight: getSetting(db, "overnight") === "true",
      keepAwake: getSetting(db, "power.keepAwake") === "true",
      // The runner keeps a past pausedUntil after the limit resets, so only a future one means paused.
      ...(waitingRaw ? { waiting: JSON.parse(waitingRaw) as { taskId: string; reason: string } } : {}),
      ...(pausedUntil > now ? { pausedUntil } : {}),
    },
    usage: { claudeTokens24h: tokens.n },
    disk: atriumDiskUsage(),
  };
}
