import { agentName } from "../engine/text";
import type { State } from "./api";

type Task = State["tasks"][number];
type Run = State["runs"][number];

export const AGENT_IDS = ["claude", "codex", "gemini"] as const;
export const AGENT_CHOICES = ["auto", ...AGENT_IDS] as const;
export type AgentChoice = (typeof AGENT_CHOICES)[number];

export { agentName } from "../engine/text";
export { verdictOf } from "../engine/verdict";

// `auto` is resolved at launch and only the run row keeps the answer; runs arrive newest first.
export const ranAgent = (task: Task, runs: Run[]) => runs.find((r) => r.taskId === task.id)?.agent ?? task.agent;

export function agentText(task: Task, runs: Run[]): string {
  const ran = ranAgent(task, runs);
  return task.agent === "auto" && ran !== "auto" ? `Auto → ${agentName(ran)}` : agentName(ran);
}

export type Wait = State["waits"][string];
export type WaitKind = Wait["kind"];

// These need Nakul to act (sign in, install, pick another agent); the rest clear up on their own.
const ACTION_KINDS = new Set<WaitKind>(["signed_out", "not_installed", "private_space", "env_files", "gemini_repo"]);
export const needsAction = (wait: Wait) => ACTION_KINDS.has(wait.kind);

// Most pressing first, for the one-line summaries: what Nakul must fix, then what's simply queued behind something.
const PRIORITY: WaitKind[] = [
  "signed_out",
  "not_installed",
  "private_space",
  "env_files",
  "gemini_repo",
  "limited",
  "reserve",
  "power",
  "cloning",
  "busy",
];
export const byPriority = (a: Wait, b: Wait) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind);

// A task that has started since the runner's last pass may still have an entry; it no longer applies.
export const waitOf = (task: Task, state: State): Wait | null =>
  task.status === "queued" ? (state.waits[task.id] ?? null) : null;

export function inReserve(state: State): { until: number } | null {
  const w = state.claudeWindow;
  return w && w.utilization >= w.reserve ? { until: w.resetsAt } : null;
}
