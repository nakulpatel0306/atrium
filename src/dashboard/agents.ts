import type { State } from "./api";
import { clock } from "./format";

type Task = State["tasks"][number];
type Run = State["runs"][number];

export const AGENT_IDS = ["claude", "codex", "gemini"] as const;
export const AGENT_CHOICES = ["auto", ...AGENT_IDS] as const;
export type AgentChoice = (typeof AGENT_CHOICES)[number];

const NAMES: Record<string, string> = { auto: "Auto", claude: "Claude", codex: "Codex", gemini: "Gemini", atrium: "Atrium" };
export const agentName = (id: string) => NAMES[id] ?? id;

// `auto` is resolved at launch and only the run row keeps the answer; runs arrive newest first.
export const ranAgent = (task: Task, runs: Run[]) => runs.find((r) => r.taskId === task.id)?.agent ?? task.agent;

export function agentText(task: Task, runs: Run[]): string {
  const ran = ranAgent(task, runs);
  return task.agent === "auto" && ran !== "auto" ? `Auto → ${agentName(ran)}` : agentName(ran);
}

export type WaitKind = "power" | "reserve" | "limit" | "signed-out" | "missing" | "guard" | "other";
export type Wait = { kind: WaitKind; text: string };

// The engine words each reason for people, so the kind is read back from that wording for its icon.
function classify(reason: string): WaitKind {
  if (reason.startsWith("Waiting for power")) return "power";
  if (reason.includes("Claude window")) return "reserve";
  if (reason.includes("signed out")) return "signed-out";
  if (reason.includes("isn't installed")) return "missing";
  if (reason.includes("can't work here") || reason.includes("only reviews code")) return "guard";
  return "other";
}

// These need Nakul to act (sign in, install, pick another agent); the rest clear up on their own.
export const needsAction = (wait: Wait) => wait.kind === "guard" || wait.kind === "signed-out" || wait.kind === "missing";

export function inReserve(state: State): { until: number } | null {
  const w = state.claudeWindow;
  return w && w.utilization >= w.reserve ? { until: w.resetsAt } : null;
}

const reserveText = (until: number) =>
  `Saving the rest of your Claude window for you (resets ${clock(until)}). Use “Run now” to override.`;

export function limitText(id: string, until: number): string {
  return `${agentName(id)} hit its usage limit and picks up again at ${clock(until)}. Pick another agent to run it sooner.`;
}

// Why a queued task isn't starting. The runner records only the first task it holds back,
// so the others are explained from the same agent state it decides with.
export function waitFor(task: Task, state: State): Wait | null {
  if (task.status !== "queued") return null;
  const recorded = state.power.waiting;
  if (recorded?.taskId === task.id) return { kind: classify(recorded.reason), text: recorded.reason };
  // An auto task that isn't sent to a free agent falls back to Claude.
  const agent = task.agent === "auto" ? "claude" : task.agent;
  const until = state.agents[agent]?.limitedUntil;
  if (until) return { kind: "limit", text: limitText(agent, until) };
  const reserve = task.agent === "claude" && !task.ignoreReserve ? inReserve(state) : null;
  if (reserve) return { kind: "reserve", text: reserveText(reserve.until) };
  return null;
}

// A reviewer's last line is `VERDICT: approve` or `VERDICT: changes`, the same line the engine acts on.
export function verdictOf(body: string): "approve" | "changes" | null {
  const m = body.trim().split("\n").at(-1)!.trim().match(/^VERDICT:\s*(approve|changes)\.?$/i);
  return m ? (m[1]!.toLowerCase() as "approve" | "changes") : null;
}
