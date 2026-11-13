// The one-line summaries both front-ends show, so the dashboard and the terminal app say the same thing.
import type { Stage } from "../engine/loop";
import { needsYouCount } from "../engine/needs";
import type { State } from "../engine/state";
import { agentName, agentText, byPriority, inReserve, needsAction, type Wait, waitOf } from "./agents";
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
  const pending = needsYouCount(state);
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

export type Review = { text: string; tone?: "ok" | "waiting" | "bad" };
type Loop = NonNullable<Task["loop"]>;

// What Atrium's checks and the reviewer made of a coding task, as one line.
export function loopLine(loop: Loop): Review {
  const parts = [loop.noChanges ? "No changes" : loop.checks === "passed" ? "Checks passed" : loop.checks === "failed" ? "Checks failed" : loop.unverified ? "Unverified: changes how dependencies install" : "Unverified: no checks found"];
  const last = loop.reviews.at(-1);
  if (last?.skipped) parts.push("review didn't happen");
  else if (last) {
    const who = agentName(last.reviewer);
    const asked = loop.reviews.flatMap((r) => (r.verdict === "changes" ? r.findings : []));
    const fixed = asked.filter((f) => f.resolution?.action === "fixed").length;
    if (asked.length) parts.push(`${who} found ${asked.length} to fix, ${fixed} fixed`);
    else parts.push(last.verdict === "approve" ? `reviewed by ${who}` : `${who} gave no verdict`);
  }
  const tone = loop.attention.length || loop.checks === "failed" ? "bad" : loop.checks === "passed" && !loop.noChanges ? "ok" : "waiting";
  return { text: parts.join(" · "), tone };
}

// The line on an approval's card, for work that went through the loop; null for anything else.
export function reviewLine(approval: Approval, state: State): Review | null {
  const loop = approval.taskId ? state.tasks.find((t) => t.id === approval.taskId)?.loop : null;
  const space = state.spaces.find((s) => s.id === approval.spaceId);
  return loop && space?.kind === "repo" ? loopLine(loop) : null;
}

export const reviewerName = (choice: Space["reviewBy"]) => (choice === "off" ? "Off" : agentName(choice));

export const STAGE_TEXT: Record<Stage | "brief", string> = { brief: "Brief", writing: "Writing", checks: "Checks", review: "Review", ready: "Ready", paused: "Paused" };

// Things the change does to the checks themselves, which every card shows before anything else.
export const attentionText = (loop: Loop | null | undefined): string | null => (loop?.attention.length ? `Look closely: ${loop.attention.join(" ")}` : null);

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
  if (reviewBy === "off") return "No review: finished code comes straight to you once its checks pass.";
  if (reviewBy === "auto") return "A fresh agent reads each change against its brief before you see it: another vendor when one can work here, else a new Claude session.";
  return `${agentName(reviewBy)} reads each change against its brief before you see it, in a fresh session. Up to two rounds of fixes, then you decide.`;
}

export const actorName = (actor: string) => (actor === "you" ? "You" : actor.charAt(0).toUpperCase() + actor.slice(1));

// The first-run hero replaces Home only when nothing exists yet; a waiting question (say, a first project's draft)
// must still be shown.
export const emptyHome = (state: State): boolean =>
  state.spaces.length === 0 && needsYouCount(state) === 0;

// One line for a row: the first paragraph of agent text, without its markdown.
export const summaryLine = (text: string): string => plainText(text.trim().split(/\n\s*\n/)[0] ?? "");
