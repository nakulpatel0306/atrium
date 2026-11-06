import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { AlreadyResolved, getApproval, resolveApproval } from "../../../src/engine/approvals";
import { openDb } from "../../../src/engine/db";
import { BAD_HANDLE_COPY, HIDDEN_COPY, TOO_LONG_COPY } from "../../../src/engine/messaging/rules";
import {
  actionForApproval,
  BadMessage,
  draftMessage,
  getMessageAction,
  messageHistory,
  pendingMessageActions,
  setCandidates,
  setMessageStatus,
  updateMessageDraft,
} from "../../../src/engine/messaging/store";
import { createSpace, type Space } from "../../../src/engine/spaces";
import { tempHome } from "../../helpers";

let home: ReturnType<typeof tempHome>;
let db: Database;
let space: Space;
beforeEach(() => {
  home = tempHome();
  db = openDb();
  space = createSpace(db, { name: "Messages", kind: "general", goal: "" });
});
afterEach(() => {
  db.close();
  home.cleanup();
});

const draft = (over: Partial<Parameters<typeof draftMessage>[1]> = {}) => draftMessage(db, { spaceId: space.id, toName: "Dana", text: "you free sat?", ...over });

test("a draft waits on an always-ask question with the exact text", () => {
  const { action, approval } = draft({ handle: "+1 (555) 010-0134", handleSource: "agent" });
  expect(action).toMatchObject({ status: "draft", handle: "+15550100134", handleSource: "agent", service: "iMessage", text: "you free sat?" });
  expect(approval).toMatchObject({ kind: "question", alwaysAsk: "send_message", spaceId: space.id, title: "Send a text to Dana?", status: "pending" });
  expect(approval.detail).toBe(
    "To: Dana · +1 555 010 0134\nVia: iMessage\n\n> you free sat?\n\nOn Send, Atrium sends exactly this from Messages on this Mac. It can't confirm delivery.",
  );
  expect(actionForApproval(db, approval.id)!.id).toBe(action.id);
  expect(pendingMessageActions(db).map((a) => a.id)).toEqual([action.id]);
});

test("a bad handle is left out and the card asks for one", () => {
  const { action, approval } = draft({ handle: '+1 555; do shell script "x"', handleSource: "agent" });
  expect([action.handle, action.handleSource]).toEqual([null, null]);
  expect(approval.detail).toContain("To: Dana · number needed");
});

test("a redraft leads with the last failure", () => {
  const { approval } = draft({ lastError: "Messages didn't answer." });
  expect(approval.detail.startsWith("Last try failed: Messages didn't answer.\nTo: Dana")).toBe(true);
});

test("a draft with bad text is refused", () => {
  expect(() => draft({ text: "a‮b" })).toThrow(BadMessage);
});

test("updateMessageDraft changes the action and the approval together", () => {
  const { action, approval } = draft({ handle: "+15550100134", handleSource: "agent" });
  const same = updateMessageDraft(db, action.id, { text: "line 1\nline 2", handle: "+1 555 010 0134", service: "SMS" });
  expect(same).toMatchObject({ text: "line 1\nline 2", handle: "+15550100134", handleSource: "agent", service: "SMS" });
  expect(getApproval(db, approval.id)!.detail).toContain("Via: SMS\n\n> line 1\n> line 2");
  const typed = updateMessageDraft(db, action.id, { text: "hi", handle: "+14165550134", service: "iMessage" });
  expect(typed.handleSource).toBe("you");
  setCandidates(db, action.id, [
    { personId: "p1", name: "Dana A", kind: "phone", label: "Mobile", handle: "+15550109999" },
    { personId: "p2", name: "Dana B", kind: "email", label: null, handle: "t@example.com" },
  ]);
  expect(updateMessageDraft(db, action.id, { text: "hi", handle: "t@example.com", service: "iMessage" }).handleSource).toBe("contacts");
});

test("updateMessageDraft refuses bad input and decided drafts", () => {
  const { action, approval } = draft();
  const refuse = (patch: Parameters<typeof updateMessageDraft>[2], copy: string) => {
    try {
      updateMessageDraft(db, action.id, patch);
      throw new Error("expected a refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(BadMessage);
      expect((e as Error).message).toBe(copy);
    }
  };
  refuse({ text: "hi", handle: "-e", service: "iMessage" }, BAD_HANDLE_COPY);
  refuse({ text: "a".repeat(2001), handle: "+14165550134", service: "iMessage" }, TOO_LONG_COPY);
  refuse({ text: "a‮b", handle: "+14165550134", service: "iMessage" }, HIDDEN_COPY);
  expect(getMessageAction(db, action.id)!.text).toBe("you free sat?");
  resolveApproval(db, approval.id, "reject");
  expect(() => updateMessageDraft(db, action.id, { text: "hi", handle: "+14165550134", service: "iMessage" })).toThrow(AlreadyResolved);
});

test("setCandidates with one pick saves it from Contacts", () => {
  const { action, approval } = draft();
  const c = [{ personId: "p1", name: "Dana", kind: "phone" as const, label: "Mobile", handle: "+15550100134" }];
  const next = setCandidates(db, action.id, c, "+15550100134");
  expect(next).toMatchObject({ handle: "+15550100134", handleSource: "contacts", candidates: c });
  expect(getApproval(db, approval.id)!.detail).toContain("To: Dana · +1 555 010 0134");
});

test("status moves are enforced and guarded", () => {
  const { action } = draft({ handle: "+15550100134" });
  expect(() => setMessageStatus(db, action.id, "sent")).toThrow();
  setMessageStatus(db, action.id, "sending");
  expect(() => setMessageStatus(db, action.id, "sending")).toThrow();
  const sent = setMessageStatus(db, action.id, "sent", { sentAt: 42 });
  expect([sent.status, sent.sentAt]).toEqual(["sent", 42]);
  expect(() => setMessageStatus(db, action.id, "failed")).toThrow();
  expect(messageHistory(db, space.id).map((a) => a.id)).toEqual([action.id]);
  draft();
  expect(messageHistory(db, space.id)).toHaveLength(1);
});
