import { AGENT_IDS } from "../../dashboard/agents";
import { bytes, clock, tokens } from "../../dashboard/format";
import { AGENT_ROLES, agentStatus, runOutcome } from "../../dashboard/summary";
import type { State } from "../../engine/state";
import type { DetailLine } from "../detail";
import { color, windowGauge } from "../theme";
import { Lines } from "./Lines";
import { Pane } from "./Pane";

const RECENT_RUNS = 5;
const RESERVE_STEPS = [0.25, 0.5, 0.75];
const GAUGE_COLS = 44;
const TONE = { bad: color.bad, waiting: color.warn } as const;

const runDate = (ts: number) =>
  new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

// Who can take work right now, what each has used, and Claude's window, as the dashboard's Agents page has it.
export function agentsLines(state: State): DetailLine[] {
  const lines: DetailLine[] = [];
  const tasks = new Map(state.tasks.map((t) => [t.id, t]));
  const ids = AGENT_IDS.filter((id) => state.agents[id]);
  if (ids.length === 0) lines.push([{ text: "No agents are set up in this engine.", color: color.muted }]);
  for (const id of ids) {
    const info = state.agents[id]!;
    const status = agentStatus(id, info, state);
    lines.push(
      [
        { text: info.label, bold: true, color: color.accent },
        { text: "  " },
        { text: status.text, color: status.tone ? TONE[status.tone] : color.ok },
        { text: `  · ${tokens(info.tokensToday)} tokens today`, color: color.muted },
      ],
      [{ text: AGENT_ROLES[id] ?? "", color: color.muted }],
      [{ text: `Last check: ${info.detail || "not checked yet"}`, color: color.muted }],
    );
    if (info.limitedUntil) lines.push([{ text: `Limit resets ${clock(info.limitedUntil)}`, color: color.warn }]);
    if (id === "claude") {
      const w = state.claudeWindow;
      const gauge = windowGauge(state, GAUGE_COLS);
      lines.push(
        [
          { text: gauge.text, color: gauge.tone === "warn" ? color.warn : undefined },
          { text: w ? ` · resets ${clock(w.resetsAt)}` : "", color: color.muted },
        ],
        [
          { text: "Pause Claude tasks at " },
          ...RESERVE_STEPS.map((step) => {
            const pct = `${Math.round(step * 100)}%`;
            const on = state.usage.claudeReserve === step;
            return { text: on ? `[${pct}] ` : ` ${pct}  `, bold: on, color: on ? color.accent : color.muted };
          }),
          { text: "used  ([ ] to change; Run now on a task skips this)", color: color.muted },
        ],
        [{ text: "Estimated from Claude's own limit reports; Atrium can't see your exact quota.", color: color.muted }],
      );
    }
    const runs = state.runs.filter((r) => r.agent === id).slice(0, RECENT_RUNS);
    if (runs.length > 0) {
      lines.push([{ text: "Recent runs", bold: true }]);
      for (const r of runs) {
        lines.push([
          { text: `${runDate(r.startedAt)}  `, color: color.muted },
          { text: tasks.get(r.taskId)?.title ?? "Task no longer listed" },
          { text: `  ${runOutcome(r)}  ${tokens(r.inputTokens + r.outputTokens)} tokens`, color: color.muted },
        ]);
      }
    }
    lines.push([]);
  }
  lines.push([
    {
      text: [
        `Claude · last 24h ${tokens(state.usage.claudeTokens24h)} tokens`,
        state.power.source === "ac" ? "Plugged in" : "On battery · heavy work waits",
        `Overnight mode ${state.power.overnight ? "on" : "off"} (o)`,
        `Atrium disk usage ${bytes(state.disk.totalBytes)}`,
      ].join(" · "),
      color: color.muted,
    },
  ]);
  return lines;
}

export function AgentsView({ lines, scroll, width, height }: { lines: DetailLine[]; scroll: number; width: number; height: number }) {
  const rows = height - 2;
  const top = Math.min(scroll, Math.max(0, lines.length - rows));
  return (
    <Pane n={0} title="Agents and usage · u or q to close" focused width={width} height={height} padded>
      <Lines lines={lines.slice(top, top + rows)} />
    </Pane>
  );
}
