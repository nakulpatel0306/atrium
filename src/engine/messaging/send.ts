import type { Database } from "bun:sqlite";
import { getApproval, isOwnYes } from "../approvals";
import { setMessagingState } from "../capabilities";
import { logActivity } from "../events";
import { getTask, setTaskOutcome, setTaskStatus } from "../tasks";
import { runOsa } from "./osascript";
import { MessagingProblem, problemFor } from "./problems";
import { displayHandle } from "./rules";
import { SEND_SCRIPT } from "./scripts";
import { draftMessage, getMessageAction, type MessageAction, setMessageStatus } from "./store";

export const REFUSED_COPY = "Only your own yes can send a message.";
export const NO_HANDLE_COPY = "Pick who this goes to first.";
export const STOPPED_COPY = "Atrium stopped while sending this. Check Messages to see whether it went out before you send it again.";
export const NOT_STARTED_COPY = "Atrium stopped before sending this, so nothing went out. Press Send again when you're ready.";

// A task that asked for a text is finished only by the engine: done once the send went through, or not done when
// Nakul chose not to send it.
function finishTask(db: Database, taskId: string | null, outcome: "done" | "couldnt", reason: string): void {
  const task = taskId ? getTask(db, taskId) : null;
  if (!task) return;
  if (task.status === "review" || task.status === "blocked" || task.status === "failed" || task.status === "queued") setTaskStatus(db, task.id, "done");
  setTaskOutcome(db, task.id, outcome, reason);
}

// The card comes back with the reason, so the next try is again Nakul's own Send.
function redraft(db: Database, a: MessageAction, error: string): void {
  draftMessage(db, {
    spaceId: a.spaceId,
    taskId: a.taskId,
    toName: a.toName,
    text: a.text,
    handle: a.handle,
    handleSource: a.handleSource,
    service: a.service,
    lastError: error,
  });
}

// Runs only after Nakul's own yes, and at most once per action: the draft → sending move is guarded, so a second
// yes, a second app or a direct call finds it already taken and does nothing.
export async function sendMessage(db: Database, actionId: string, opts: { timeoutMs?: number } = {}): Promise<MessageAction> {
  const action = getMessageAction(db, actionId);
  if (!action) throw new Error(`No message draft with id ${actionId}`);
  if (action.status !== "draft") return action;
  const approval = getApproval(db, action.approvalId);
  if (approval?.status === "pending") return action;
  if (!approval || !isOwnYes(approval) || approval.alwaysAsk !== "send_message" || !action.handle) {
    const why = approval && isOwnYes(approval) && approval.alwaysAsk === "send_message" ? NO_HANDLE_COPY : REFUSED_COPY;
    logActivity(db, action.spaceId, "atrium", `Didn't send the text to ${action.toName}: ${why}`);
    return setMessageStatus(db, action.id, "failed", { error: why });
  }
  try {
    setMessageStatus(db, action.id, "sending");
  } catch {
    return getMessageAction(db, action.id)!;
  }
  const { handle, service, text, toName } = action;
  let problem: MessagingProblem | null = null;
  try {
    const res = await runOsa(SEND_SCRIPT, [service, handle, text], opts);
    if (res.code !== 0 || res.timedOut || res.out.trim() !== "ATRIUM_SENT") problem = problemFor(res, "Messages", service);
  } catch (e) {
    problem = new MessagingProblem("other", problemFor({ code: 1, out: "", err: "", timedOut: false }, "Messages").message, (e as Error).message);
  }
  if (!problem) {
    const sent = setMessageStatus(db, action.id, "sent", { sentAt: Date.now() });
    setMessagingState(db, "ready");
    logActivity(db, action.spaceId, "atrium", `Sent via Messages to ${toName} (${displayHandle(handle)}). Atrium can't confirm delivery.`);
    finishTask(db, action.taskId, "done", `Sent via Messages to ${toName}. Delivery isn't confirmed.`);
    return sent;
  }
  const failed = setMessageStatus(db, action.id, "failed", { error: problem.message });
  if (problem.kind === "automation_denied") setMessagingState(db, "needs_automation");
  if (problem.kind === "signed_out") setMessagingState(db, "signed_out");
  logActivity(db, action.spaceId, "atrium", `Couldn't send the text to ${toName}: ${problem.message}`);
  redraft(db, failed, problem.message);
  return failed;
}

export function rejectMessage(db: Database, actionId: string): void {
  const action = getMessageAction(db, actionId);
  if (action?.status !== "draft") return;
  setMessageStatus(db, action.id, "rejected");
  finishTask(db, action.taskId, "couldnt", "You chose not to send it.");
}

// Never sends. A send cut off mid-way may or may not have gone out, so it comes back as a draft that says so; a
// yes that never reached osascript comes back as a draft too, since nothing resends on its own.
export function recoverMessageActions(db: Database): number {
  const rows = db
    .query(
      `SELECT m.id, m.status, a.status AS decided FROM message_actions m JOIN approvals a ON a.id = m.approval_id
       WHERE m.status = 'sending' OR (m.status = 'draft' AND a.status != 'pending')`,
    )
    .all() as { id: string; status: string; decided: string }[];
  for (const r of rows) {
    if (r.status === "draft" && r.decided === "rejected") {
      rejectMessage(db, r.id);
      continue;
    }
    const error = r.status === "sending" ? STOPPED_COPY : NOT_STARTED_COPY;
    const failed = setMessageStatus(db, r.id, "failed", { error });
    redraft(db, failed, error);
  }
  return rows.length;
}
