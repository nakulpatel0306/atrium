import type { Database } from "bun:sqlite";
import { type Approval, listPending } from "./approvals";
import type { Registry } from "./agents/registry";
import { briefing } from "./briefing";
import { type ActivityRow, listActivity } from "./events";
import { getSetting } from "./settings";
import { type Space, listSpaces } from "./spaces";
import { atriumDiskUsage } from "./storage";
import { type Task, listTasks } from "./tasks";

export type RunSummary = {
  id: string;
  taskId: string;
  agent: string;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  inputTokens: number;
  outputTokens: number;
};

export type AgentInfo = {
  label: string;
  installed: boolean;
  loggedIn: boolean | null;
  detail: string;
  limitedUntil: number | null;
  tokensToday: number;
};

export type State = {
  spaces: Space[];
  tasks: Task[];
  runs: RunSummary[];
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
  agents: Record<string, AgentInfo>;
  // The last five-hour reading while its window is still open; null when unknown or already reset.
  claudeWindow: { utilization: number; resetsAt: number; reserve: number } | null;
  disk: ReturnType<typeof atriumDiskUsage>;
};

export function snapshot(db: Database, registry?: Registry): State {
  const now = Date.now();
  const waitingRaw = getSetting(db, "runner.waiting");
  const pausedUntil = Number(getSetting(db, "agent.claude.limitedUntil") ?? 0);
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  const todayTokens = new Map(
    (
      db
        .query("SELECT agent, SUM(input_tokens + output_tokens) AS n FROM runs WHERE started_at >= ? GROUP BY agent")
        .all(midnight) as { agent: string; n: number }[]
    ).map((r) => [r.agent, r.n]),
  );
  const agents = Object.fromEntries(
    Object.entries(registry?.statuses() ?? {}).map(([id, s]) => [
      id,
      { label: registry!.adapters[id]!.label, ...s, tokensToday: todayTokens.get(id) ?? 0 },
    ]),
  );
  const windowRaw = getSetting(db, "usage.claude.fiveHour");
  const window = windowRaw ? (JSON.parse(windowRaw) as { utilization: number; resetsAt: number }) : null;
  const tokens = db
    .query("SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS n FROM runs WHERE started_at > ?")
    .get(now - 24 * 3600_000) as { n: number };
  return {
    spaces: listSpaces(db),
    tasks: listTasks(db),
    // rowid breaks ties between runs started in the same millisecond
    runs: db
      .query(
        `SELECT id, task_id AS taskId, agent, started_at AS startedAt, ended_at AS endedAt, exit_code AS exitCode,
                input_tokens AS inputTokens, output_tokens AS outputTokens
         FROM runs ORDER BY started_at DESC, rowid DESC LIMIT 200`,
      )
      .all() as RunSummary[],
    approvals: listPending(db),
    activity: listActivity(db, { limit: 100 }),
    briefing: briefing(db, now),
    power: {
      source: getSetting(db, "power.source") === "battery" ? "battery" : "ac",
      overnight: getSetting(db, "overnight") === "true",
      keepAwake: getSetting(db, "power.keepAwake") === "true",
      // A limit's time stays stored after it resets, so only a future one means paused.
      ...(waitingRaw ? { waiting: JSON.parse(waitingRaw) as { taskId: string; reason: string } } : {}),
      ...(pausedUntil > now ? { pausedUntil } : {}),
    },
    usage: { claudeTokens24h: tokens.n },
    agents,
    claudeWindow:
      window && window.resetsAt > now
        ? { ...window, reserve: Number(getSetting(db, "usage.claude.reserve") ?? 0.5) }
        : null,
    disk: atriumDiskUsage(),
  };
}
