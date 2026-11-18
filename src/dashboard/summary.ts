// The one-line summaries both front-ends show, so the dashboard and the terminal app say the same thing.
import type { Stage } from "../engine/loop";
import { cleanResult, needsYouCount, pausedForYou, reviewSettled } from "../engine/needs";
import { RISKY, TASK_WORD, taskWord } from "../engine/words";
import type { State } from "../engine/state";
import { agentName, agentText, byPriority, inReserve, needsAction, type Wait, waitOf } from "./agents";
import { clock, relative } from "./format";
import { plainText } from "./markdown";
import { plainStop, shortStop } from "../engine/text";

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

// A task's one word, from engine/words.ts: "blocked" splits into paused (waits for your hint) and stopped (waits for a
// retry).
export const STATUS_TEXT: Record<Task["status"], string> = {
  queued: TASK_WORD.queued,
  running: TASK_WORD.running,
  review: TASK_WORD.review,
  done: TASK_WORD.done,
  failed: TASK_WORD.failed,
  blocked: TASK_WORD.stopped,
};
export const taskText = (t: Task): string => TASK_WORD[taskWord(t)];

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
  // A brief's questions are one per task, each answered on its own; other waits read the same for every task they hold.
  for (const wait of waitsOf(tasks, state)) {
    const key = wait.kind === "answers" ? `${wait.reason}:${wait.taskId}` : wait.reason;
    if (!waits.has(key)) waits.set(key, wait);
  }
  return [...waits.values()];
}

// `inQueue`: what the line says is already a row in Needs you (a pause, a result, a brief's question), so Home's card
// can leave it to that row.
export type SpaceStatus = { text: string; tone?: "blocked" | "waiting"; wait?: Wait; inQueue?: boolean };

export function spaceStatus(space: Space, tasks: Task[], state: State, now = Date.now()): SpaceStatus {
  const running = tasks.find((t) => t.status === "running");
  if (running) return { text: `${agentText(running, state.runs)} running · ${running.title}` };
  // A stopped task isn't in Needs you, so its line wins over anything that is (a question, a pause), which Home shows
  // as a row of its own.
  const stopped = tasks.filter((t) => t.status === "blocked" && !pausedForYou(t));
  const queuedWait = (w: Wait) => w.kind === "answers" || w.kind === "pick" || w.kind === "parts";
  const wait = waitsOf(tasks, state).find((w) => !(stopped.length && queuedWait(w)));
  if (wait) return { text: wait.reason, tone: needsAction(wait) ? "blocked" : "waiting", wait, inQueue: queuedWait(wait) };
  // Stopped and failed tasks are the space's own news; pauses wait in Needs you.
  const stuck = tasks.filter((t) => (t.status === "blocked" && !pausedForYou(t)) || t.status === "failed");
  if (stuck.length === 1 && stuck[0]!.status === "blocked") {
    const t = stuck[0]!;
    // A stopped task needs a retry and reads red.
    return { text: `Stopped: ${(t.blockedReason && shortStop(t.blockedReason)) || t.title}`, tone: "blocked" };
  }
  if (stuck.length > 0) return { text: `${stuck.length} need${stuck.length === 1 ? "s" : ""} attention`, tone: "blocked" };
  const paused = tasks.filter((t) => pausedForYou(t));
  if (paused.length === 1) {
    // A pause is a normal stop that waits for a hint, so it reads amber.
    return { text: `Paused: ${paused[0]!.loop?.paused?.diagnosis ?? paused[0]!.title}`, tone: "waiting", inQueue: true };
  }
  if (paused.length > 1) return { text: `${paused.length} paused`, tone: "waiting", inQueue: true };
  const review = tasks.filter((t) => t.status === "review").length;
  if (review > 0) return { text: `${review} ready for your review`, inQueue: true };
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
  // A pause is already one of the things that need you; only other stops are news here.
  const blocked = state.tasks.filter((t) => t.status === "blocked" && !pausedForYou(t));
  if (blocked.length === 1) {
    const reason = blocked[0]!.blockedReason && shortStop(blocked[0]!.blockedReason).replace(/\.$/, "");
    parts.push(`1 stopped${reason ? `: ${reason}` : ""}`);
  } else if (blocked.length > 1) parts.push(`${blocked.length} stopped`);
  // Queueing behind a running task is the normal case, not news, and a brief's questions are already counted above.
  const waits = waitsOf(state.tasks, state).filter((w) => w.kind !== "busy" && w.kind !== "answers");
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
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// What the checks said and what the reviewer said, as two separate chips, each in its own colour: checks that passed
// stay green even when the review left something open. Whatever needs you leads its chip ("1 open finding"), so a
// narrow row never cuts it off.
export function loopChips(loop: Loop): { checks: Review; review: Review | null } {
  const checks: Review = loop.noChanges
    ? { text: "No changes" }
    : loop.checks === "passed"
      ? { text: "Checks passed", tone: "ok" }
      : loop.checks === "failed"
        ? { text: "Checks failed", tone: "bad" }
        : { text: loop.unverified ? "Unverified: changes how dependencies install" : "Unverified: no checks found", tone: "waiting" };
  const last = loop.reviews.at(-1);
  if (!last) return { checks, review: null };
  if (last.skipped) return { checks, review: { text: "Review didn't happen", tone: "waiting" } };
  const who = agentName(last.reviewer);
  const tone = reviewSettled(loop) ? "ok" : "waiting";
  const asked = loop.reviews.flatMap((r) => (r.verdict === "changes" ? r.findings : []));
  if (asked.length) {
    // How each finding ended, so "asked for changes" and a result waiting for you don't read as a contradiction.
    const open = asked.filter((f) => !f.resolution).length;
    if (open) return { checks, review: { text: `${plural(open, "open finding")} · ${who}`, tone } };
    const count = (action: "fixed" | "declined") => asked.filter((f) => f.resolution?.action === action).length;
    const ended = [count("fixed") && `${count("fixed")} fixed`, count("declined") && `${count("declined")} declined`].filter(Boolean).join(", ");
    return { checks, review: { text: `${who}: ${ended}`, tone } };
  }
  if (last.verdict !== "approve") return { checks, review: { text: `${who} gave no verdict`, tone } };
  // Notes on an approval are the reviewer's asides: shown, never something to answer.
  const notes = last.findings.filter((f) => !f.resolution).length;
  return { checks, review: { text: `Approved by ${who}${notes ? ` · ${plural(notes, "note")}` : ""}`, tone } };
}

// The same two as one line, for a terminal row or a tooltip. Red only for failing checks; green exactly when the
// result is clean by the one rule (needs.ts); amber otherwise.
export function loopLine(loop: Loop): Review {
  const { checks, review } = loopChips(loop);
  const tone = loop.checks === "failed" ? "bad" : cleanResult({ outcome: "done", loop }) ? "ok" : "waiting";
  return { text: [checks.text, review?.text].filter(Boolean).join(" · "), tone };
}

// The loop behind an approval's card, for repo work that went through it; null for anything else.
function loopOf(approval: Approval, state: State): Loop | null {
  const loop = approval.taskId ? state.tasks.find((t) => t.id === approval.taskId)?.loop : null;
  const space = state.spaces.find((s) => s.id === approval.spaceId);
  return loop && space?.kind === "repo" ? loop : null;
}

export function reviewLine(approval: Approval, state: State): Review | null {
  const loop = loopOf(approval, state);
  return loop ? loopLine(loop) : null;
}

export function reviewChips(approval: Approval, state: State): ReturnType<typeof loopChips> | null {
  const loop = loopOf(approval, state);
  return loop ? loopChips(loop) : null;
}

export const reviewerName = (choice: Space["reviewBy"]) => (choice === "off" ? "Off" : agentName(choice));

export const STAGE_TEXT: Record<Stage, string> = {
  brief: "Brief",
  writing: "Writing",
  checks: "Checks",
  // The reviewer's pass, not your decision (which the queue calls a Review).
  review: "Reviewer",
  ready: "Ready",
  paused: "Paused",
  parts: "Parts",
  judge: "Judging",
  pick: "Your pick",
};

// Things the change does to the checks themselves, which every card shows before anything else.
export const attentionText = (loop: Loop | null | undefined): string | null => (loop?.attention.length ? `${RISKY}: ${loop.attention.join(" ")}` : null);

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

// How a review finding ended, naming who answered it. A note on an approval was never put to the writer.
export function answeredText(f: { resolution: { action: "fixed" | "declined"; note: string } | null }, asked: boolean): string {
  if (!asked) return "A note on an approval, nothing to answer.";
  if (!f.resolution) return "The writer didn't answer it.";
  const note = f.resolution.note ? `: ${f.resolution.note}` : ".";
  return f.resolution.action === "fixed" ? `The writer fixed it${note}` : `The writer declined it${note}`;
}
