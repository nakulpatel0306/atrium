import type { Database } from "bun:sqlite";
import type { AgentRunResult } from "./agents/types";
import { appendApprovalDetail, pendingReviewFor } from "./approvals";
import { addMessage } from "./messages";
import type { Space } from "./spaces";
import { createTask, getTask, type Task } from "./tasks";

const CLIP_CHARS = 600;
const NAMES: Record<string, string> = { claude: "Claude", codex: "Codex", gemini: "Gemini" };
const name = (id: string) => NAMES[id] ?? id;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const clip = (text: string) => (text.length > CLIP_CHARS ? `${text.slice(0, CLIP_CHARS)}…` : text);

// `auto` is resolved per run and only the run row keeps the answer.
function resolvedAgent(db: Database, task: Task): string {
  const row = db
    .query("SELECT agent FROM runs WHERE task_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1")
    .get(task.id) as { agent: string } | null;
  return row?.agent ?? task.agent;
}

function child(db: Database, parentId: string, kind: Task["kind"]): Task | null {
  const row = db
    .query("SELECT id FROM tasks WHERE parent_task_id = ? AND kind = ? ORDER BY created_at, rowid LIMIT 1")
    .get(parentId, kind) as { id: string } | null;
  return row ? getTask(db, row.id) : null;
}

function verdict(summary: string): "approve" | "changes" | null {
  const last = summary.trim().split("\n").at(-1)!.trim();
  const m = last.match(/^VERDICT:\s*(approve|changes)\.?$/i);
  return m ? (m[1]!.toLowerCase() as "approve" | "changes") : null;
}

function reviewPrompt(task: Task, worker: string, diff: string): string {
  return [
    `${name(worker)} finished the task below on ${task.branch}. Review the change it made.`,
    `Original task: ${task.title}`,
    ...(task.detail.trim() ? [task.detail.trim()] : []),
    "The whole change is in the diff below. You can't open the repo and don't need to.",
    "List bugs, missing cases and risky changes, most important first, each with the file it's in. Skip style nits.",
    "Your last line must be exactly `VERDICT: approve` if it's ready as is, or `VERDICT: changes` if it needs fixes first.",
    `--- diff ---\n${diff}\n--- end of diff ---`,
  ].join("\n\n");
}

// Called once the work's approval exists. At most one review per task: a send-back reruns the work, not the review.
export function afterWork(db: Database, task: Task, space: Space, approvalId: string, diff: string, files: number): void {
  const reviewer = space.reviewBy;
  if (task.kind !== "work" || !reviewer || files === 0 || !task.branch) return;
  const worker = resolvedAgent(db, task);
  if (reviewer === worker || child(db, task.id, "review")) return;
  createTask(db, {
    spaceId: space.id,
    title: `Review: ${task.title}`,
    detail: reviewPrompt(task, worker, diff),
    weight: "light",
    allowOnBattery: true,
    kind: "review",
    parentTaskId: task.id,
    agent: reviewer,
  });
  addMessage(db, {
    spaceId: space.id,
    taskId: task.id,
    fromAgent: worker,
    toAgent: reviewer,
    body: `Please review ${plural(files, "file")} on ${task.branch}.`,
  });
  appendApprovalDetail(db, approvalId, `\n\n${name(reviewer)} is reviewing this. You can decide now without waiting.`);
}

// A failed or skipped review only adds to the thread: the approval Nakul sees stays as the work left it.
export function afterReview(db: Database, reviewTask: Task, result: AgentRunResult): void {
  const parent = reviewTask.parentTaskId ? getTask(db, reviewTask.parentTaskId) : null;
  if (!parent) return;
  const worker = resolvedAgent(db, parent);
  const reviewer = reviewTask.agent;
  const thread = { spaceId: parent.spaceId, taskId: parent.id };
  if (result.status !== "ok") {
    addMessage(db, {
      ...thread,
      fromAgent: "atrium",
      toAgent: worker,
      body: `${name(reviewer)}'s review didn't happen: ${result.message} The approval is unchanged; decide on it as usual.`,
    });
    return;
  }
  const summary = result.summary.trim();
  addMessage(db, { ...thread, fromAgent: reviewer, toAgent: worker, body: summary });
  const approval = pendingReviewFor(db, parent.id);
  if (!approval) return;
  appendApprovalDetail(db, approval.id, `\n\n**${name(reviewer)} reviewed:** ${clip(summary)}`);
  // One fix round at most, and no second review after it, so the loop always ends with Nakul.
  if (verdict(summary) !== "changes" || child(db, parent.id, "fix")) return;
  createTask(db, {
    spaceId: parent.spaceId,
    title: `Fix: ${parent.title}`,
    detail: [
      `${name(reviewer)} reviewed your work on this task and asked for changes. Make them on this branch; your earlier commits are already on it.`,
      `Original task: ${parent.title}`,
      ...(parent.detail.trim() ? [parent.detail.trim()] : []),
      `Review:\n${summary}`,
    ].join("\n\n"),
    weight: parent.weight,
    allowOnBattery: parent.allowOnBattery,
    kind: "fix",
    parentTaskId: parent.id,
    agent: worker,
  });
  appendApprovalDetail(
    db,
    approval.id,
    `\n\nFix in progress: ${name(worker)} is making the changes ${name(reviewer)} asked for on ${parent.branch}. There's no second review after it.`,
  );
}

// `report` is the branch summary after the fix, which now covers the work and the fix together.
export function afterFix(db: Database, fixTask: Task, summary: string, report: string): void {
  const parent = fixTask.parentTaskId ? getTask(db, fixTask.parentTaskId) : null;
  if (!parent) return;
  const worker = resolvedAgent(db, fixTask);
  const review = child(db, parent.id, "review");
  const text = summary.trim();
  if (review) addMessage(db, { spaceId: parent.spaceId, taskId: parent.id, fromAgent: worker, toAgent: review.agent, body: text });
  const approval = pendingReviewFor(db, parent.id);
  if (approval) appendApprovalDetail(db, approval.id, `\n\n**${name(worker)} fixed:** ${clip(text)}${report ? `\n\n${report}` : ""}`);
}
