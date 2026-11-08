import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getApproval, listPending, onApprovalResolved, resolveApproval, SEPARATELY_NOTE } from "../../../src/engine/approvals";
import { messagingState } from "../../../src/engine/capabilities";
import { openDb } from "../../../src/engine/db";
import { listActivity } from "../../../src/engine/events";
import { createMessaging, PICK_AGAIN_COPY } from "../../../src/engine/messaging";
import { matchChats, noPickCopy, parseChats } from "../../../src/engine/messaging/chats";
import { FIND_COPY, MessagingProblem, PROBLEM_COPY } from "../../../src/engine/messaging/problems";
import { maskHandle, peopleLine } from "../../../src/engine/messaging/rules";
import { CHATS_SCRIPT, SEND_CHAT_SCRIPT } from "../../../src/engine/messaging/scripts";
import { NO_CHAT_COPY, NO_PEOPLE_COPY, recoverMessageActions, sendMessage, sendSeparately, STOPPED_COPY } from "../../../src/engine/messaging/send";
import { BadMessage, draftGroupMessage, getMessageAction, type GroupChat, pendingMessageActions, setGroupChat, setMessageStatus, updateMessageDraft } from "../../../src/engine/messaging/store";
import { createSpace, type Space } from "../../../src/engine/spaces";
import { createTask, getTask, setTaskStatus } from "../../../src/engine/tasks";
import { tempHome } from "../../helpers";

let home: ReturnType<typeof tempHome>;
let db: Database;
let space: Space;
let log: string;
let messaging: ReturnType<typeof createMessaging>;
let off: () => void;

// What Messages lists: two hiking chats, a family chat, and an unnamed chat of exactly Sam and Priya.
const CHATS = [
  ["iMessage;+;chat-hike", "Hike crew", "iMessage", [["+14165550134", "Sam Lee"], ["priya@example.com", "Priya Shah"], ["+14165550199", "Jo Park"], ["+14165550177", null]]],
  ["iMessage;+;chat-hike2", "Hike crew 2019", "iMessage", [["+14165550134", "Sam Lee"], ["+14165550188", "Dev Rao"]]],
  ["SMS;+;chat-family", "Family", "SMS", [["+14165550111", "Mom"], ["+14165550122", "Dad"]]],
  ["iMessage;+;chat-sp", null, "iMessage", [["+14165550134", "Sam Lee"], ["priya@example.com", "Priya Shah"]]],
];

beforeEach(() => {
  home = tempHome();
  db = openDb();
  space = createSpace(db, { name: "Messages", kind: "general", goal: "" });
  log = join(home.home, "osa.log");
  process.env.FAKE_OSASCRIPT_LOG = log;
  process.env.FAKE_OSASCRIPT_CHATS = JSON.stringify(CHATS);
  messaging = createMessaging({ db, kick: () => {}, timeoutMs: 5000 });
  off = onApprovalResolved(messaging.onDecision);
});
afterEach(async () => {
  off();
  await messaging.settle();
  for (const k of ["FAKE_OSASCRIPT_LOG", "FAKE_OSASCRIPT_MODE", "FAKE_OSASCRIPT_CHATS"]) delete process.env[k];
  db.close();
  home.cleanup();
});

const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]) : []);
const sent = () => calls().filter((a) => a.includes("set target to chat id chatId") || a.includes("send body to participant target of (item 1 of accts)")).map((a) => a.slice(a.indexOf("--") + 1));
const activity = () => listActivity(db, { spaceId: space.id }).map((r) => r.message);
const group = (over: Partial<Parameters<typeof draftGroupMessage>[1]> = {}) =>
  draftGroupMessage(db, { spaceId: space.id, name: "Hike crew", people: [], text: "lock in saturday?", ...over });
const hike = (): GroupChat => parseChats(listing()).find((c) => c.id === "iMessage;+;chat-hike")!;
const C = String.fromCharCode;
const listing = () =>
  CHATS.map(([id, name, svc, ps]) => [id, name ?? "missing value", svc, (ps as [string, string | null][]).map(([h, n]) => `${h}${C(28)}${n ?? "missing value"}`).join(C(29))].join(C(31))).join(C(30));
function waitingTask() {
  const t = createTask(db, { spaceId: space.id, title: "Draft a group text to Hike crew" });
  setTaskStatus(db, t.id, "running");
  return setTaskStatus(db, t.id, "review");
}

describe("draft", () => {
  test("a group draft names the group, keeps the people and has no target until Find", () => {
    const { action, approval } = group({ people: ["Sam", "Priya"] });
    expect(action).toMatchObject({ toName: "Hike crew", handle: null, service: "iMessage", status: "draft", group: { name: "Hike crew", people: ["Sam", "Priya"], chat: null } });
    expect(approval).toMatchObject({ title: "Send a text to Hike crew?", alwaysAsk: "send_message", status: "pending" });
    expect(approval.detail).toContain("To: Hike crew · group chat not found yet");
    expect(approval.detail).toContain("People: Sam, Priya");
    const named = draftGroupMessage(db, { spaceId: space.id, name: null, people: ["Sam", "Priya", "Jo"], text: "hi" });
    expect(named.action.toName).toBe("Sam, Priya and Jo");
  });

  test("a name that could fake the card is refused", () => {
    expect(() => group({ people: ["Sam\nTo: Mom"] })).toThrow(BadMessage);
    expect(() => group({ name: "Hike · +14165550134" })).toThrow(BadMessage);
  });

  test("a group draft never takes a typed number", () => {
    const { action } = group();
    expect(() => updateMessageDraft(db, action.id, { text: "hi", handle: "+14165550134", service: "iMessage" })).toThrow(BadMessage);
  });

  test("picking a chat retitles the card and stores only id, name, service and masked members", () => {
    const { action } = group({ name: "hikers" });
    const picked = setGroupChat(db, action.id, hike());
    expect(picked.group!.chat).toEqual({
      id: "iMessage;+;chat-hike",
      name: "Hike crew",
      service: "iMessage",
      participants: [
        { name: "Sam Lee", handle: "+1 ••• ••• 0134" },
        { name: "Priya Shah", handle: "p••@example.com" },
        { name: "Jo Park", handle: "+1 ••• ••• 0199" },
        { name: null, handle: "+1 ••• ••• 0177" },
      ],
    });
    const row = JSON.stringify(db.query("SELECT * FROM message_actions WHERE id = ?").get(action.id));
    expect(row).not.toContain("4165550134");
    expect(row).not.toContain("priya@example.com");
    const approval = getApproval(db, action.approvalId)!;
    expect(approval.title).toBe("Send a text to Hike crew?");
    expect(approval.detail).toContain("People: Sam Lee, Priya Shah, Jo Park, +1 ••• ••• 0177");
  });
});

describe("rules", () => {
  test("masking and people lines", () => {
    expect(maskHandle("+14165550134")).toBe("+1 ••• ••• 0134");
    expect(maskHandle("+447700900123")).toBe("••• 0123");
    expect(maskHandle("sam@example.com")).toBe("s••@example.com");
    expect(maskHandle("12")).toBe("••••");
    expect(peopleLine(["Sam"])).toBe("Sam");
    expect(peopleLine(["Sam", "Priya"])).toBe("Sam and Priya");
    const many = Array.from({ length: 12 }, (_, i) => `Person Number ${i}`);
    expect(peopleLine(many)).toBe("Person Number 0, Person Number 1 and 10 others");
    expect(peopleLine(["x".repeat(50), "y".repeat(50), "z"])).toBe("3 people");
  });
});

describe("lookup", () => {
  const chats = () => parseChats(listing());

  test("parsing drops broken records and one-person chats", () => {
    const broken = `${listing()}${C(30)}bad${C(31)}only two${C(30)}id-1${C(31)}Solo${C(31)}iMessage${C(31)}+1555${C(28)}Ann`;
    expect(parseChats(broken).map((c) => c.id)).toEqual(CHATS.map((c) => c[0] as string));
    expect(chats().find((c) => c.id === "iMessage;+;chat-sp")!.name).toBeNull();
    expect(chats().find((c) => c.id === "SMS;+;chat-family")!.service).toBe("SMS");
  });

  test("by name: his exact words pick the chat; a close name lists first", () => {
    expect(matchChats(chats(), { name: "hike  CREW", people: [] }).picked?.id).toBe("iMessage;+;chat-hike");
    const close = matchChats(chats(), { name: "hike", people: [] });
    expect(close.picked).toBeNull();
    expect(close.shown.slice(0, 2).map((c) => c.name)).toEqual(["Hike crew", "Hike crew 2019"]);
    expect(close.message).toBe('More than one group chat could be "hike". Pick the right one.');
  });

  test("by people: the one chat of exactly them is picked, wherever it's named", () => {
    expect(matchChats(chats(), { name: null, people: ["Sam", "Priya"] }).picked?.id).toBe("iMessage;+;chat-sp");
    expect(matchChats(chats(), { name: "the trail gang", people: ["Sam", "Priya"] }).picked?.id).toBe("iMessage;+;chat-sp");
    // "Sam" is not "Samantha", and a name that also names people must hold them.
    expect(matchChats(chats(), { name: null, people: ["Samantha", "Priya"] }).picked).toBeNull();
    expect(matchChats(chats(), { name: "Hike crew", people: ["Mom"] }).picked).toBeNull();
  });

  test("no match lists everything found, at most 20, and offers sending separately", () => {
    const many = Array.from({ length: 30 }, (_, i): GroupChat => ({ id: `c${i}`, name: `Chat ${i}`, service: "iMessage", participants: [{ name: "A", handle: "x" }, { name: "B", handle: "y" }] }));
    const none = matchChats(many, { name: "Book club", people: ["Sam", "Priya"] });
    expect(none.picked).toBeNull();
    expect(none.shown).toHaveLength(20);
    expect(none.message).toBe('No group chat in Messages matches "Book club". Pick one below, or send the text to each person separately.');
    expect(noPickCopy({ name: null, people: ["Sam", "Priya"] }, 0, 0)).toBe("Messages has no group chats on this Mac. You can send the text to each person separately instead.");
    expect(noPickCopy({ name: "Book club", people: [] }, 3, 1)).toBe('No group chat is exactly "Book club". The closest one is first. Pick it if it\'s right.');
  });

  test("Find reads only the chat list, stores a single match and remembers the rest for a pick", async () => {
    const { action } = group({ name: "Hike crew" });
    const found = await messaging.findChat(action.id);
    expect(found.picked?.id).toBe("iMessage;+;chat-hike");
    expect(getMessageAction(db, action.id)!.group!.chat!.id).toBe("iMessage;+;chat-hike");
    expect(calls()).toEqual([[...CHATS_SCRIPT.flatMap((l) => ["-e", l]), "--"]]);
    expect(CHATS_SCRIPT.join("\n")).not.toMatch(/messages of|text of|every message/i);

    const other = group({ name: "hike" });
    const close = await messaging.findChat(other.action.id);
    expect(close.picked).toBeNull();
    expect(getMessageAction(db, other.action.id)!.group!.chat).toBeNull();
    expect(() => messaging.pickChat(other.action.id, "iMessage;+;chat-made-up")).toThrow(PICK_AGAIN_COPY);
    expect(messaging.pickChat(other.action.id, "iMessage;+;chat-hike2").group!.chat!.name).toBe("Hike crew 2019");
    // A chat Find listed can still replace one it picked on its own.
    expect(messaging.pickChat(action.id, "SMS;+;chat-family").group!.chat).toMatchObject({ name: "Family", service: "SMS" });
    expect(getMessageAction(db, action.id)!.service).toBe("SMS");
  });

  test("Find denied, hung or broken says to press Find again", async () => {
    const { action } = group();
    process.env.FAKE_OSASCRIPT_MODE = "denied";
    const denied = await messaging.findChat(action.id).catch((e) => e);
    expect([denied instanceof MessagingProblem, denied.message]).toEqual([true, FIND_COPY.automation_denied]);
    expect(messagingState(db)).toBe("needs_automation");
    process.env.FAKE_OSASCRIPT_MODE = "fail";
    expect((await messaging.findChat(action.id).catch((e) => e)).message).toBe(FIND_COPY.other);
  });
});

describe("send", () => {
  const picked = (over: Partial<Parameters<typeof draftGroupMessage>[1]> = {}) => group({ chat: hike(), ...over });

  test("Nakul's yes sends to the chat id once, names the group and its size, and finishes the task", async () => {
    const t = waitingTask();
    const { action, approval } = picked({ taskId: t.id });
    resolveApproval(db, approval.id, "approve");
    await messaging.settle();
    expect(sent()).toEqual([["iMessage;+;chat-hike", "lock in saturday?"]]);
    expect(getMessageAction(db, action.id)!.status).toBe("sent");
    expect(activity()).toContain("Sent a text to Hike crew (4 people). Atrium can't confirm delivery.");
    expect(activity()).toContain("Pressed Send: text to Hike crew");
    expect(getTask(db, t.id)).toMatchObject({ status: "done", outcome: "done", outcomeReason: "Sent via Messages to Hike crew. Delivery isn't confirmed." });
    expect(messagingState(db)).toBe("ready");
  });

  test("a double press sends once", async () => {
    const { action, approval } = picked();
    const a = resolveApproval(db, approval.id, "approve");
    messaging.onDecision(a, "approve");
    messaging.onDecision(a, "approve");
    await Promise.all([sendMessage(db, action.id), sendMessage(db, action.id), messaging.settle()]);
    await messaging.settle();
    expect(sent()).toHaveLength(1);
  });

  test("quotes, backslashes and newlines reach Messages as one literal argument", async () => {
    const text = `say "hi" & (do shell script "id")\nback\\slash \\\\ two\nend tell\n-e`;
    const { approval } = picked({ text });
    resolveApproval(db, approval.id, "approve");
    await messaging.settle();
    const [row] = calls().filter((a) => a.includes("set target to chat id chatId"));
    expect(row).toEqual([...SEND_CHAT_SCRIPT.flatMap((l) => ["-e", l]), "--", "iMessage;+;chat-hike", text]);
    expect(SEND_CHAT_SCRIPT.some((l) => l.includes(text) || l.includes("chat-hike"))).toBe(false);
  });

  test("no chat yet never sends", async () => {
    const { action, approval } = group();
    off();
    resolveApproval(db, approval.id, "approve");
    expect(await sendMessage(db, action.id)).toMatchObject({ status: "failed", error: NO_CHAT_COPY });
    expect(sent()).toEqual([]);
  });

  test("a chat that's gone comes back without its chat, so Find runs again", async () => {
    for (const [mode, chats] of [["ok", "[]"], ["chat_error", JSON.stringify(CHATS)]] as const) {
      process.env.FAKE_OSASCRIPT_MODE = mode;
      process.env.FAKE_OSASCRIPT_CHATS = chats;
      const { action, approval } = picked();
      resolveApproval(db, approval.id, "approve");
      await messaging.settle();
      expect(getMessageAction(db, action.id)).toMatchObject({ status: "failed", error: PROBLEM_COPY.chat_gone });
      const again = pendingMessageActions(db).at(-1)!;
      expect(again).toMatchObject({ error: PROBLEM_COPY.chat_gone, text: "lock in saturday?", group: { name: "Hike crew", chat: null } });
      expect(activity()).toContain(`Couldn't send the text to Hike crew: ${PROBLEM_COPY.chat_gone}`);
    }
  });

  test("signed out and Automation denied keep the chat and say what to do", async () => {
    process.env.FAKE_OSASCRIPT_MODE = "no_account";
    const one = picked();
    resolveApproval(db, one.approval.id, "approve");
    await messaging.settle();
    expect(getMessageAction(db, one.action.id)!.error).toBe(PROBLEM_COPY.signed_out);
    expect(messagingState(db)).toBe("signed_out");
    process.env.FAKE_OSASCRIPT_MODE = "denied";
    const two = picked();
    resolveApproval(db, two.approval.id, "approve");
    await messaging.settle();
    expect(getMessageAction(db, two.action.id)!.error).toBe(PROBLEM_COPY.automation_denied);
    expect(messagingState(db)).toBe("needs_automation");
    expect(pendingMessageActions(db).every((a) => a.group?.chat?.id === "iMessage;+;chat-hike")).toBe(true);
  });

  test("recovery brings a cut-off group send back as a draft with its chat, never resending", () => {
    const { action } = picked();
    off();
    resolveApproval(db, action.approvalId, "approve");
    setMessageStatus(db, action.id, "sending");
    expect(recoverMessageActions(db)).toBe(1);
    expect(pendingMessageActions(db)[0]).toMatchObject({ error: STOPPED_COPY, group: { chat: { id: "iMessage;+;chat-hike" } } });
    expect(sent()).toEqual([]);
  });
});

describe("send separately", () => {
  test("makes one ordinary draft per person, each waiting for its own yes", async () => {
    const t = waitingTask();
    const { action, approval } = group({ name: "Book club", people: ["Sam", "Priya"], taskId: t.id });
    const made = messaging.separately(action.id, "edited: saturday?");
    expect(made.map((m) => [m.toName, m.text, m.group, m.taskId])).toEqual([
      ["Sam", "edited: saturday?", null, t.id],
      ["Priya", "edited: saturday?", null, t.id],
    ]);
    expect(getMessageAction(db, action.id)!.status).toBe("split");
    expect(getApproval(db, approval.id)).toMatchObject({ status: "rejected", note: SEPARATELY_NOTE });
    expect(activity()).toContain("Chose to send separately: text to Book club");
    expect(getTask(db, t.id)!.status).toBe("review");
    await messaging.settle();
    // Nothing went out: each person's text is its own card in Needs you.
    expect(calls()).toEqual([]);
    expect(listPending(db).map((a) => a.title).sort()).toEqual(["Send a text to Priya?", "Send a text to Sam?"]);

    // Only Nakul's yes on one of them sends that one, on the one-person path.
    const sam = pendingMessageActions(db).find((m) => m.toName === "Sam")!;
    updateMessageDraft(db, sam.id, { text: sam.text, handle: "+14165550134", service: "iMessage" });
    resolveApproval(db, sam.approvalId, "approve");
    await messaging.settle();
    expect(sent()).toEqual([["iMessage", "+14165550134", "edited: saturday?"]]);
    expect(pendingMessageActions(db).map((m) => m.toName)).toEqual(["Priya"]);
  });

  test("a second press, or a text already decided, splits nothing", () => {
    const { action, approval } = group({ people: ["Sam", "Priya"] });
    messaging.separately(action.id, "hi");
    expect(() => messaging.separately(action.id, "hi")).toThrow();
    expect(pendingMessageActions(db)).toHaveLength(2);
    const other = group({ people: ["Jo", "Dev"], chat: hike() });
    off();
    resolveApproval(db, other.approval.id, "approve");
    expect(() => sendSeparately(db, other.action.id, "hi")).toThrow();
    expect(getMessageAction(db, other.action.id)!.status).toBe("draft");
    expect(pendingMessageActions(db)).toHaveLength(2);
    expect(approval.status).toBe("pending");
  });

  test("with only a chat name, it uses the picked chat's named members, else asks to find the chat", () => {
    const bare = group();
    expect(() => sendSeparately(db, bare.action.id, "hi")).toThrow(NO_PEOPLE_COPY);
    const withChat = group({ chat: hike() });
    expect(sendSeparately(db, withChat.action.id, "hi").map((m) => m.toName)).toEqual(["Sam Lee", "Priya Shah", "Jo Park"]);
  });
});
