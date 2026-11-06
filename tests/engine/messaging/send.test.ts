import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getApproval, listPending, onApprovalResolved, resolveApproval } from "../../../src/engine/approvals";
import { messagingState } from "../../../src/engine/capabilities";
import { openDb } from "../../../src/engine/db";
import { listActivity } from "../../../src/engine/events";
import { createMessaging } from "../../../src/engine/messaging";
import { PROBLEM_COPY } from "../../../src/engine/messaging/problems";
import { NO_HANDLE_COPY, recoverMessageActions, REFUSED_COPY, sendMessage, STOPPED_COPY } from "../../../src/engine/messaging/send";
import { draftMessage, getMessageAction, pendingMessageActions, setMessageStatus } from "../../../src/engine/messaging/store";
import { createSpace, type Space } from "../../../src/engine/spaces";
import { createTask, getTask, setTaskStatus } from "../../../src/engine/tasks";
import { tempHome } from "../../helpers";

let home: ReturnType<typeof tempHome>;
let db: Database;
let space: Space;
let log: string;
let messaging: ReturnType<typeof createMessaging>;
let off: () => void;
beforeEach(() => {
  home = tempHome();
  db = openDb();
  space = createSpace(db, { name: "Messages", kind: "general", goal: "" });
  log = join(home.home, "osa.log");
  process.env.FAKE_OSASCRIPT_LOG = log;
  messaging = createMessaging({ db, kick: () => {}, timeoutMs: 5000 });
  off = onApprovalResolved(messaging.onDecision);
});
afterEach(async () => {
  off();
  await messaging.settle();
  for (const k of ["FAKE_OSASCRIPT_LOG", "FAKE_OSASCRIPT_MODE"]) delete process.env[k];
  db.close();
  home.cleanup();
});

const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]) : []);
const sends = () => calls().map((a) => a.slice(a.indexOf("--") + 1));

function waitingTask() {
  const t = createTask(db, { spaceId: space.id, title: "Draft a text to Dana" });
  setTaskStatus(db, t.id, "running");
  return setTaskStatus(db, t.id, "review");
}
const draft = (over: Partial<Parameters<typeof draftMessage>[1]> = {}) =>
  draftMessage(db, { spaceId: space.id, toName: "Dana", text: "you free sat?", handle: "+15550100134", handleSource: "contacts", ...over });
const activity = () => listActivity(db, { spaceId: space.id }).map((r) => r.message);

test("Nakul's yes sends exactly the stored text once and finishes the task", async () => {
  const t = waitingTask();
  const { action, approval } = draft({ taskId: t.id });
  resolveApproval(db, approval.id, "approve");
  await messaging.settle();
  expect(sends()).toEqual([["iMessage", "+15550100134", "you free sat?"]]);
  expect(getMessageAction(db, action.id)!.status).toBe("sent");
  expect(getTask(db, t.id)).toMatchObject({ status: "done", outcome: "done", outcomeReason: "Sent via Messages to Dana. Delivery isn't confirmed." });
  expect(activity()).toContain("Sent via Messages to Dana (+1 555 010 0134). Atrium can't confirm delivery.");
  expect(messagingState(db)).toBe("ready");
});

test("two yeses send once", async () => {
  const { action, approval } = draft();
  const a = resolveApproval(db, approval.id, "approve");
  messaging.onDecision(a, "approve");
  messaging.onDecision(a, "approve");
  await Promise.all([sendMessage(db, action.id), messaging.settle()]);
  await messaging.settle();
  expect(sends()).toHaveLength(1);
  expect(db.query("SELECT COUNT(*) AS n FROM message_actions WHERE status = 'sent'").get()).toEqual({ n: 1 });
});

test("an undone or missing yes never sends", async () => {
  const { action, approval } = draft();
  off();
  resolveApproval(db, approval.id, "approve");
  db.query("UPDATE approvals SET undone_at = 1 WHERE id = ?").run(approval.id);
  const res = await sendMessage(db, action.id);
  expect([res.status, res.error]).toEqual(["failed", REFUSED_COPY]);
  expect(calls()).toEqual([]);
  const pending = draft();
  expect((await sendMessage(db, pending.action.id)).status).toBe("draft");
  expect(calls()).toEqual([]);
});

test("no handle never sends", async () => {
  const { action, approval } = draft({ handle: null });
  off();
  resolveApproval(db, approval.id, "approve");
  const res = await sendMessage(db, action.id);
  expect([res.status, res.error]).toEqual(["failed", NO_HANDLE_COPY]);
  expect(calls()).toEqual([]);
});

test("Automation denied brings the card back and keeps the task waiting", async () => {
  process.env.FAKE_OSASCRIPT_MODE = "denied";
  const t = waitingTask();
  const { action, approval } = draft({ taskId: t.id });
  resolveApproval(db, approval.id, "approve");
  await messaging.settle();
  expect(getMessageAction(db, action.id)).toMatchObject({ status: "failed", error: PROBLEM_COPY.automation_denied });
  const [again] = pendingMessageActions(db);
  expect(again).toMatchObject({ taskId: t.id, handle: "+15550100134", handleSource: "contacts", text: "you free sat?", error: PROBLEM_COPY.automation_denied });
  expect(getApproval(db, again!.approvalId)!.detail.startsWith(`Last try failed: ${PROBLEM_COPY.automation_denied}`)).toBe(true);
  expect(getTask(db, t.id)!.status).toBe("review");
  expect(messagingState(db)).toBe("needs_automation");
  expect(activity()).toContain(`Couldn't send the text to Dana: ${PROBLEM_COPY.automation_denied}`);
});

test("signed out, and a hung Messages", async () => {
  process.env.FAKE_OSASCRIPT_MODE = "no_account";
  const one = draft();
  resolveApproval(db, one.approval.id, "approve");
  await messaging.settle();
  expect(getMessageAction(db, one.action.id)!.error).toBe(PROBLEM_COPY.signed_out);
  expect(messagingState(db)).toBe("signed_out");
  process.env.FAKE_OSASCRIPT_MODE = "hang";
  const two = draft();
  off();
  resolveApproval(db, two.approval.id, "approve");
  await sendMessage(db, two.action.id, { timeoutMs: 200 });
  expect(getMessageAction(db, two.action.id)!.error).toBe(PROBLEM_COPY.timeout.Messages);
  expect(pendingMessageActions(db).some((a) => a.error === PROBLEM_COPY.timeout.Messages)).toBe(true);
});

test("Don't send marks the task not done and sends nothing", async () => {
  const t = waitingTask();
  const { action, approval } = draft({ taskId: t.id });
  resolveApproval(db, approval.id, "reject");
  await messaging.settle();
  expect(getMessageAction(db, action.id)!.status).toBe("rejected");
  expect(getTask(db, t.id)).toMatchObject({ status: "done", outcome: "couldnt", outcomeReason: "You chose not to send it." });
  expect(calls()).toEqual([]);
});

test("recoverMessageActions never resends", () => {
  const t = waitingTask();
  const { action } = draft({ taskId: t.id });
  off();
  resolveApproval(db, action.approvalId, "approve");
  setMessageStatus(db, action.id, "sending");
  const orphan = draft();
  resolveApproval(db, orphan.approval.id, "approve");
  expect(recoverMessageActions(db)).toBe(2);
  expect(getMessageAction(db, action.id)).toMatchObject({ status: "failed", error: STOPPED_COPY });
  expect(getMessageAction(db, orphan.action.id)!.status).toBe("failed");
  const back = pendingMessageActions(db);
  expect(back).toHaveLength(2);
  expect(back.find((a) => a.taskId === t.id)!.error).toBe(STOPPED_COPY);
  expect(getTask(db, t.id)!.status).toBe("review");
  expect(calls()).toEqual([]);
  expect(recoverMessageActions(db)).toBe(0);
  expect(listPending(db)).toHaveLength(2);
});
