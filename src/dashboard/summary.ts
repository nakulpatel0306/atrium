// The one-line summaries both front-ends show, so the dashboard and the terminal app say the same thing.
import type { Message } from "../engine/messages";
import type { State } from "../engine/state";
import { agentName, agentText, byPriority, inReserve, needsAction, ranAgent, verdictOf, type Wait, waitOf } from "./agents";
import { clock, relative } from "./format";
import { plainText } from "./markdown";

type Space = State["spaces"][number];
type Task = State["tasks"][number];
type Run = State["runs"][number];
type Approval = State["approvals"][number];
type AgentInfo = State["agents"][string];

// Archived spaces leave Home, so their tasks, approvals and suggestions must not linger in its counts and lists.
export function activeOnly(state: State): State {
  const ids = new Set(state.spaces.map((s) => s.id));
  return {
    ...state,
    tasks: state.tasks.filter((t) => ids.has(t.spaceId)),
    // Atrium-wide questions (no space) always stay.
    approvals: state.approvals.filter((a) => a.spaceId === null || ids.has(a.spaceId)),
    proposals: state.proposals.filter((p) => ids.has(p.spaceId)),
  };
}

export const STATUS_TEXT: Record<Task["status"], string> = {
  queued: "queued",
  running: "running",
  review: "in review",
  done: "done",
  failed: "failed",
  blocked: "blocked",
};

export const KIND_PREFIX: Record<Exclude<Task["kind"], "work">, string> = { review: "Review: ", fix: "Fix: " };

// The engine titles child tasks "Review: …" and "Fix: …"; the badge says that, so the title needn't.
export function shownTitle(task: Task): string {
  if (task.kind === "work") return task.title;
  const prefix = KIND_PREFIX[task.kind];
  return task.title.startsWith(prefix) ? task.title.slice(prefix.length) : task.title;
}

const ORDER: Task["status"][] = ["running", "blocked", "failed", "review", "queued"];

// Open work in queue order, finished work newest first underneath.
export function orderedTasks(tasks: Task[]): Task[] {
  const open = ORDER.flatMap((s) => tasks.filter((t) => t.status === s));
  const done = tasks.filter((t) => t.status === "done").reverse();
  return [...open, ...done];
}

// Every held-back task's wait, most pressing first.
const waitsOf = (tasks: Task[], state: State): Wait[] =>
  tasks.flatMap((t) => waitOf(t, state) ?? []).sort(byPriority);

// One per distinct reason, so three tasks held by the same limit don't repeat it.
export function distinctWaits(tasks: Task[], state: State): Wait[] {
  const waits = new Map<string, Wait>();
  for (const wait of waitsOf(tasks, state)) if (!waits.has(wait.reason)) waits.set(wait.reason, wait);
  return [...waits.values()];
}

export type SpaceStatus = { text: string; tone?: "blocked" | "waiting"; wait?: Wait };

export function spaceStatus(space: Space, tasks: Task[], state: State, now = Date.now()): SpaceStatus {
  const running = tasks.find((t) => t.status === "running");
  if (running) return { text: `${agentText(running, state.runs)} running · ${running.title}` };
  const [wait] = waitsOf(tasks, state);
  if (wait) return { text: wait.reason, tone: needsAction(wait) ? "blocked" : "waiting", wait };
  const stuck = tasks.filter((t) => t.status === "blocked" || t.status === "failed");
  if (stuck.length === 1 && stuck[0]!.status === "blocked") {
    return { text: `Blocked: ${stuck[0]!.blockedReason ?? stuck[0]!.title}`, tone: "blocked" };
  }
  if (stuck.length > 0) return { text: `${stuck.length} need${stuck.length === 1 ? "s" : ""} attention`, tone: "blocked" };
  const review = tasks.filter((t) => t.status === "review").length;
  if (review > 0) return { text: `${review} ready for your review` };
  const queued = tasks.filter((t) => t.status === "queued").length;
  if (queued > 0) return { text: `${queued} ${queued === 1 ? "task" : "tasks"} queued` };
  const last = state.activity.find((a) => a.spaceId === space.id)?.createdAt ?? space.updatedAt;
  return { text: `Idle · last activity ${relative(last, now)}` };
}

// Composed from live state on every render so counts never go stale while the page stays open.
export function liveStatus(state: State): string {
  const parts: string[] = [];
  const pending = state.approvals.length + state.proposals.length;
  if (pending > 0) parts.push(`${pending} ${pending === 1 ? "thing needs" : "things need"} you`);
  const blocked = state.tasks.filter((t) => t.status === "blocked");
  if (blocked.length > 0) {
    const reason = blocked[0]!.blockedReason;
    parts.push(`${blocked.length} blocked${reason ? ` (${reason})` : ""}`);
  }
  // Queueing behind a running task is the normal case, not news.
  const waits = waitsOf(state.tasks, state).filter((w) => w.kind !== "busy");
  if (waits.length > 0) {
    const more = waits.length - 1;
    parts.push(`${waits[0]!.reason.replace(/\.$/, "")}${more > 0 ? ` (${more} more ${more === 1 ? "task" : "tasks"} waiting)` : ""}`);
  }
  return parts.length ? ` ${parts.join(". ")}.` : "";
}

export function liveRun(state: State, tasks: Task[]): { task: Task; run: Run } | null {
  const task = tasks.find((t) => t.status === "running");
  const run = task && state.runs.find((r) => r.taskId === task.id && r.endedAt === null);
  return task && run ? { task, run } : null;
}

export const runOutcome = (run: Run): "running" | "finished" | "ended without finishing" =>
  run.endedAt === null ? "running" : run.exitCode === 0 ? "finished" : "ended without finishing";

export type Review = { text: string; tone?: "ok" | "waiting" | "bad"; fixing: boolean };

const FIX_STATE: Partial<Record<Task["status"], string>> = {
  queued: "fix in progress",
  running: "fix in progress",
  done: "fixed",
  failed: "fix didn't finish",
  blocked: "fix didn't finish",
};

function reviewChildren(approval: Approval, state: State): { review?: Task; fix?: Task } {
  const children = approval.taskId ? state.tasks.filter((t) => t.parentTaskId === approval.taskId) : [];
  return { review: children.find((t) => t.kind === "review"), fix: children.find((t) => t.kind === "fix") };
}

// The verdict lives in the thread, which is only worth reading once the review has finished without a fix.
export function reviewTarget(approval: Approval, state: State): string | null {
  const { review } = reviewChildren(approval, state);
  return review?.status === "done" ? approval.taskId : null;
}

// The second agent's part in this approval, as one line; null when the space doesn't review.
export function reviewLine(approval: Approval, state: State, messages: Message[] | null): Review | null {
  const { review, fix } = reviewChildren(approval, state);
  if (!review) return null;
  const who = agentName(review.agent);
  if (review.status !== "done") return { text: `${who} is reviewing · you can decide now`, tone: "waiting", fixing: false };
  if (fix) {
    const worker = agentName(ranAgent(fix, state.runs));
    const step = FIX_STATE[fix.status] ?? "fix in progress";
    return { text: `${who} asked for changes · ${step === "fixed" ? `${worker} fixed them` : step}`, tone: "waiting", fixing: true };
  }
  if (!messages) return { text: `Reviewed by ${who}`, fixing: false };
  const said = messages.filter((m) => m.fromAgent === review.agent).at(-1);
  if (!said) return { text: `${who}'s review didn't happen · decide as usual`, tone: "bad", fixing: false };
  const verdict = verdictOf(said.body);
  if (verdict === "approve") return { text: `Reviewed by ${who} · approve`, tone: "ok", fixing: false };
  if (verdict === "changes") return { text: `${who} asked for changes`, tone: "waiting", fixing: false };
  return { text: `Reviewed by ${who} · no verdict, see the thread`, fixing: false };
}

// What the router lets each agent do, so a reader knows why work went where it did.
export const AGENT_ROLES: Record<string, string> = {
  claude: "Does repo work and everything in private spaces. Auto sends work here unless Claude's window is being saved.",
  codex:
    "Reviews finished work, and takes general tasks while Claude's window is saved. Never works in private spaces or repos with .env files.",
  gemini:
    "Reviews code and takes general tasks Codex can't. Never edits repos, and never works in private spaces or repos with .env files.",
};

export type AgentLine = { text: string; tone?: "bad" | "waiting" };

export function agentStatus(id: string, info: AgentInfo, state: State): AgentLine {
  if (!info.installed) return { text: `Not installed. ${info.detail}`, tone: "bad" };
  if (info.loggedIn === false) return { text: `Signed out. ${info.detail}`, tone: "bad" };
  if (info.limitedUntil) return { text: `Limited until ${clock(info.limitedUntil)}`, tone: "waiting" };
  const reserve = id === "claude" ? inReserve(state) : null;
  if (reserve) return { text: `Saving your window until ${clock(reserve.until)}`, tone: "waiting" };
  return { text: "Ready" };
}

export function reviewHint(reviewBy: Space["reviewBy"]): string {
  if (!reviewBy) return "A second agent can read each finished change before you approve it.";
  // The engine skips the review when the reviewer is the agent that did the work.
  return `${agentName(reviewBy)} reads each finished change it didn't make and can ask for one round of fixes. You still decide.`;
}

export const actorName = (actor: string) => (actor === "you" ? "You" : actor.charAt(0).toUpperCase() + actor.slice(1));

// The first-run hero replaces Home only when nothing exists yet; a waiting question (say, a first project's draft)
// must still be shown.
export const emptyHome = (state: State): boolean =>
  state.spaces.length === 0 && state.approvals.length === 0 && state.proposals.length === 0;

// One line for a row: the first paragraph of agent text, without its markdown.
export const summaryLine = (text: string): string => plainText(text.trim().split(/\n\s*\n/)[0] ?? "");
