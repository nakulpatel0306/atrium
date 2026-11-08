import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getApproval, listPending, onApprovalResolved, resolveApproval, SEPARATELY_NOTE } from "../../../src/engine/approvals";
import { messagingState } from "../../../src/engine/capabilities";
import { openDb } from "../../../src/engine/db";
import { listActivity } from "../../../src/engine/events";
import { createMessaging, PICK_AGAIN_COPY } from "../../../src/engine/messaging";
import { findTimeout } from "../../../src/engine/messaging";
import { matchChats, messagesName, noPickCopy, parseChats } from "../../../src/engine/messaging/chats";
import { FIND_COPY, findProblem, MessagingProblem, PROBLEM_COPY, problemFor } from "../../../src/engine/messaging/problems";
import { maskHandle, NO_NAME_COPY, peopleLine, separatePlan } from "../../../src/engine/messaging/rules";
import { CHAT_GONE_CATCH, CHATS_SCRIPT, SEND_CHAT_SCRIPT } from "../../../src/engine/messaging/scripts";
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
const hike = (): GroupChat => parseChats(listing()).chats.find((c) => c.id === "iMessage;+;chat-hike")!;
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
  const chats = () => parseChats(listing()).chats;
  const rec = (id: string, name: string, members: [string, string][], svc = "iMessage") => [id, name, svc, members.map(([h, n]) => `${h}${C(28)}${n}`).join(C(29))].join(C(31));

  test("parsing drops broken records and counts them with the chats the script skipped", () => {
    const broken = `${listing()}${C(30)}bad${C(31)}only two${C(30)}${rec("not-an-id", "Solo", [["+15550100111", "Ann"], ["+15550100112", "Bo"]])}${C(30)}ATRIUM_SKIPPED${C(31)}3`;
    const parsed = parseChats(broken);
    expect(parsed.chats.map((c) => c.id)).toEqual(CHATS.map((c) => c[0] as string));
    expect(parsed.skipped).toBe(5);
    expect(chats().find((c) => c.id === "iMessage;+;chat-sp")!.name).toBeNull();
    expect(chats().find((c) => c.id === "SMS;+;chat-family")!.service).toBe("SMS");
  });

  test("M1: an id or handle in the wrong shape, or an id seen twice, drops the chat", () => {
    const people: [string, string][] = [["+15550100111", "Ann"], ["+15550100112", "Bo"]];
    const out = [
      rec("iMessage;+;chat-ok", "Ok", people),
      rec("iMessage;+;chat ok", "Space in id", people),
      rec("iMessage;+;chat-bad-handle", "Bad handle", [["+15550100111", "Ann"], ["-e", "Bo"]]),
      rec("iMessage;+;chat-twice", "Real", people),
      rec("iMessage;+;chat-twice", "Forged", [["+15550100999", "Mom"], ["+15550100998", "Dad"]]),
    ].join(C(30));
    const parsed = parseChats(out);
    expect(parsed.chats.map((c) => c.id)).toEqual(["iMessage;+;chat-ok"]);
    expect(parsed.skipped).toBe(4);
  });

  test("M2, M3: names from Messages get the agent's name rule, and a number is never a name", () => {
    expect(messagesName("Hike crew")).toBe("Hike crew");
    expect(messagesName("missing value")).toBeNull();
    expect(messagesName("+1 (416) 555-0101")).toBeNull();
    expect(messagesName("sam@example.com")).toBeNull();
    expect(messagesName("Hike crew · Mom, Dad +1 416 555 0134")).toBeNull();
    expect(messagesName("Mom | Dad")).toBeNull();
    const [chat] = parseChats(rec("iMessage;+;chat-x", "Hike crew · Mom, Dad +1 416 555 0134", [["+14165550101", "+1 (416) 555-0101"], ["+14165550102", "Bo Li"]])).chats;
    expect(chat).toEqual({ id: "iMessage;+;chat-x", name: null, service: "iMessage", participants: [{ name: null, handle: "+1 ••• ••• 0101" }, { name: "Bo Li", handle: "+1 ••• ••• 0102" }] });
    expect(JSON.stringify(chat)).not.toContain("0101)");
  });

  test("H1: a name alone never picks a chat; it ranks the list and says who's in it", () => {
    const one = matchChats(chats(), { name: "hike  CREW", people: [] });
    expect(one.picked).toBeNull();
    expect(one.shown[0]!.id).toBe("iMessage;+;chat-hike");
    expect(one.message).toBe('Found 1 group chat named "hike  CREW" in Messages: Sam Lee, Priya Shah, Jo Park, +1 ••• ••• 0177. Pick it if that\'s who you mean.');
    // The reviewer's case: someone renamed a work chat "Family"; Nakul's family chat is unnamed.
    const renamed: GroupChat[] = [
      { id: "iMessage;+;chat-work", name: "Family", service: "iMessage", participants: [{ name: "Bob Work", handle: "x" }, { name: "Carol Work", handle: "y" }] },
      { id: "iMessage;+;chat-fam", name: null, service: "iMessage", participants: [{ name: "Mom", handle: "a" }, { name: "Dad", handle: "b" }] },
    ];
    expect(matchChats(renamed, { name: "Family", people: [] }).picked).toBeNull();
    const close = matchChats(chats(), { name: "hike", people: [] });
    expect(close.picked).toBeNull();
    expect(close.shown.slice(0, 2).map((c) => c.name)).toEqual(["Hike crew", "Hike crew 2019"]);
    expect(close.message).toBe('More than one group chat could be "hike". Pick the right one.');
  });

  test("H1: members pick a chat, his name breaks a tie, and the card is told why", () => {
    const sp = matchChats(chats(), { name: null, people: ["Sam", "Priya"] });
    expect(sp.picked?.id).toBe("iMessage;+;chat-sp");
    expect(sp.message).toBe("Picked the unnamed group because its members are exactly Sam and Priya.");
    expect(matchChats(chats(), { name: "the trail gang", people: ["Sam", "Priya"] }).picked?.id).toBe("iMessage;+;chat-sp");
    // "Sam" is not "Samantha"; a chat with someone extra in it is never picked.
    expect(matchChats(chats(), { name: null, people: ["Samantha", "Priya"] }).picked).toBeNull();
    expect(matchChats(chats(), { name: "Hike crew", people: ["Sam", "Priya", "Jo"] }).picked).toBeNull();
    const twins: GroupChat[] = ["Book club", "Old book club"].map((name, i) => ({ id: `iMessage;+;c${i}`, name, service: "iMessage", participants: [{ name: "Ann", handle: "a" }, { name: "Bo", handle: "b" }] }));
    expect(matchChats(twins, { name: null, people: ["Ann", "Bo"] }).picked).toBeNull();
    const tie = matchChats(twins, { name: "Book club", people: ["Ann", "Bo"] });
    expect(tie.picked?.name).toBe("Book club");
    expect(tie.message).toBe('Picked "Book club" because its members are exactly Ann and Bo.');
  });

  test("no match lists everything found, at most 20, offers sending separately, and counts unread chats", () => {
    const many = Array.from({ length: 30 }, (_, i): GroupChat => ({ id: `c${i}`, name: `Chat ${i}`, service: "iMessage", participants: [{ name: "A", handle: "x" }, { name: "B", handle: "y" }] }));
    const none = matchChats(many, { name: "Book club", people: ["Sam", "Priya"] }, 3);
    expect(none.picked).toBeNull();
    expect(none.shown).toHaveLength(20);
    expect(none.message).toBe('No group chat in Messages matches "Book club". Pick one below, or send the text to each person separately. Atrium couldn\'t read 3 chats.');
    expect(noPickCopy({ name: null, people: ["Sam", "Priya"] }, 0, 0)).toBe("Messages has no group chats on this Mac. You can send the text to each person separately instead.");
    expect(noPickCopy({ name: "Book club", people: [] }, 3, 1)).toBe('No group chat is exactly "Book club". The closest one is first. Pick it if it\'s right.');
  });

  test("Find reads only the chat list, stores a members match and remembers the list for a pick", async () => {
    const { action } = group({ name: null, people: ["Sam", "Priya"] });
    const found = await messaging.findChat(action.id);
    expect(found.picked?.id).toBe("iMessage;+;chat-sp");
    expect(getMessageAction(db, action.id)!.group!.chat!.id).toBe("iMessage;+;chat-sp");
    expect(calls()).toEqual([[...CHATS_SCRIPT.flatMap((l) => ["-e", l]), "--"]]);
    expect(CHATS_SCRIPT.join("\n")).not.toMatch(/messages of|text of|every message/i);

    const other = group({ name: "Hike crew" });
    const named = await messaging.findChat(other.action.id);
    expect(named.picked).toBeNull();
    expect(getMessageAction(db, other.action.id)!.group!.chat).toBeNull();
    expect(() => messaging.pickChat(other.action.id, "iMessage;+;chat-made-up")).toThrow(PICK_AGAIN_COPY);
    expect(messaging.pickChat(other.action.id, "iMessage;+;chat-hike").group!.chat!.name).toBe("Hike crew");
    expect(messaging.pickChat(action.id, "SMS;+;chat-family").group!.chat).toMatchObject({ name: "Family", service: "SMS" });
    expect(getMessageAction(db, action.id)!.service).toBe("SMS");
  });

  test("L1: Find again never replaces a chat he picked himself", async () => {
    const { action } = group({ name: null, people: ["Sam", "Priya"] });
    await messaging.findChat(action.id);
    messaging.pickChat(action.id, "iMessage;+;chat-hike");
    const again = await messaging.findChat(action.id);
    expect(again.picked).toBeNull();
    expect(again.message).toBe("Find matched the unnamed group: its members are exactly Sam and Priya. Pick it below to use it instead of the chat on this text.");
    expect(getMessageAction(db, action.id)!.group!.chat!.id).toBe("iMessage;+;chat-hike");
  });

  test("Find denied, hung or broken says to press Find again; a timeout says why it may be slow", async () => {
    const { action } = group();
    process.env.FAKE_OSASCRIPT_MODE = "denied";
    const denied = await messaging.findChat(action.id).catch((e) => e);
    expect([denied instanceof MessagingProblem, denied.message]).toEqual([true, FIND_COPY.automation_denied]);
    expect(messagingState(db)).toBe("needs_automation");
    process.env.FAKE_OSASCRIPT_MODE = "fail";
    expect((await messaging.findChat(action.id).catch((e) => e)).message).toBe(FIND_COPY.other);
    const slow = findProblem({ code: 137, out: "", err: "", timedOut: true });
    expect([slow.kind, slow.message]).toEqual(["timeout", FIND_COPY.timeout]);
    expect(FIND_COPY.timeout).toContain("very long chat history");
    // Find gets 60 seconds unless a test sets its own.
    expect([findTimeout(), findTimeout(5000)]).toEqual([60_000, 5000]);
  });

  test("H2, M5: the chat list reads each chat in its own try, falls back on the service, and opens only group chats", () => {
    const lines = [...CHATS_SCRIPT];
    const at = (l: string) => lines.indexOf(l);
    expect(at("set allIds to id of every chat")).toBeGreaterThan(-1);
    // One-person chats (";-;") are never opened; members are read only after that check, in bulk.
    const filter = at('if chatKey does not contain ";-;" then');
    expect(filter).toBeGreaterThan(at("set allIds to id of every chat"));
    expect(filter).toBeLessThan(at("set c to chat id chatKey"));
    expect(lines).toContain('if chatKey contains ";+;" or (count of hs) > 1 then');
    expect(lines.filter((l) => /participant/.test(l))).toEqual(["set hs to handle of every participant of c", "set ns to full name of every participant of c"]);
    expect(lines.some((l) => /\bname of p\b|every chat\)/.test(l))).toBe(false);
    // A chat that errors costs one row, and the service has its own fallback.
    expect(at("try")).toBeLessThan(at("set c to chat id chatKey"));
    expect(lines.slice(at("on error"), at("on error") + 2)).toEqual(["on error", "set skipped to skipped + 1"]);
    const svc = at("set svc to (service type of (account of c)) as text");
    expect(lines.slice(svc - 2, svc + 2)).toEqual(['set svc to "SMS"', "try", "set svc to (service type of (account of c)) as text", "end try"]);
    // Every value goes through clean() before it's joined with the separators.
    expect(lines.find((l) => l.startsWith("set end of recs to my clean(chatKey"))).toBe("set end of recs to my clean(chatKey, bad) & us & cname & us & my clean(svc, bad) & us & mt");
    expect(lines).toContain("set end of members to my clean((item j of hs) as text, bad) & fs & my clean((item j of ns) as text, bad)");
  });
});

// The scripts' own AppleScript, run by the real osascript with no application named, so nothing can ask macOS for a
// permission or touch Messages.
describe.skipIf(process.platform !== "darwin")("the real osascript", () => {
  const real = (lines: readonly string[], args: string[]) => {
    expect(lines.some((l) => /tell|application/i.test(l))).toBe(false);
    const p = Bun.spawnSync(["/usr/bin/osascript", ...lines.flatMap((l) => ["-e", l]), "--", ...args]);
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };

  test("M1: clean() strips every control character, so no name can carry a separator", async () => {
    const { BAD_CHARS, CLEAN_HANDLER } = await import("../../../src/engine/messaging/scripts");
    const forged = `x${C(30)}iMessage;+;chat-evil${C(31)}Family${C(31)}iMessage${C(31)}+1555${C(28)}Mom${C(29)}+1556${C(28)}Dad${C(30)}z\t${C(1)}é😀`;
    const res = real(["on run argv", ...BAD_CHARS, "return my clean(item 1 of argv, bad)", "end run", ...CLEAN_HANDLER], [forged]);
    expect(res.out).toBe("xiMessage;+;chat-evilFamilyiMessage+1555Mom+1556Dadzé😀\n");
  });

  test("M4: only -1728 and -1719 read as a missing chat; anything else is raised again", () => {
    const script = ["on run argv", "try", 'error "boom" number ((item 1 of argv) as integer)', ...CHAT_GONE_CATCH, 'return "fine"', "end run"];
    expect(real(script, ["-1728"]).out).toBe("ATRIUM_NO_CHAT\n");
    expect(real(script, ["-1719"]).out).toBe("ATRIUM_NO_CHAT\n");
    for (const n of ["-1743", "-600", "-1712"]) {
      const res = real(script, [n]);
      expect([res.code, res.err.includes(`(${n})`)]).toEqual([1, true]);
    }
    expect(SEND_CHAT_SCRIPT.join("\n")).toContain(CHAT_GONE_CATCH.join("\n"));
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
      // L4: finding a chat happens on the dashboard, so the copy says where, even when it shows in the terminal.
      expect(PROBLEM_COPY.chat_gone).toContain("Press Find group chat on the dashboard card");
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

  test("M4: only a missing chat reads as gone; other errors keep the chat and get their own wording", async () => {
    const res = (err: string, out = "") => ({ code: out ? 0 : 1, out, err, timedOut: false });
    expect(problemFor(res("", "ATRIUM_NO_CHAT"), "Messages", "iMessage", true).kind).toBe("chat_gone");
    expect(problemFor(res("execution error: Can't get chat id \"x\". (-1728)"), "Messages", "iMessage", true).kind).toBe("chat_gone");
    expect(problemFor(res("execution error: Messages got an error: Can't get chat. (-1700)"), "Messages", "iMessage", true).kind).toBe("other");
    expect(problemFor(res("execution error: Messages got an error: Application isn't running. (-600)"), "Messages", "iMessage", true).kind).toBe("other");
    // A one-person send never reads as a gone chat.
    expect(problemFor(res("execution error: Can't get chat id \"x\". (-1728)"), "Messages", "iMessage").kind).toBe("other");
    process.env.FAKE_OSASCRIPT_MODE = "fail";
    const { action, approval } = picked();
    resolveApproval(db, approval.id, "approve");
    await messaging.settle();
    expect(getMessageAction(db, action.id)!.error).toBe(PROBLEM_COPY.other.Messages);
    expect(pendingMessageActions(db).at(-1)!.group!.chat!.id).toBe("iMessage;+;chat-hike");
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
    expect(made.skipped).toEqual([]);
    expect(made.drafts.map((m) => [m.toName, m.text, m.group, m.taskId])).toEqual([
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

  test("M6: with a chat picked it texts exactly the members the card shows, and lists anyone it can't", () => {
    const bare = group();
    expect(() => sendSeparately(db, bare.action.id, "hi")).toThrow(NO_PEOPLE_COPY);
    // The agent named two people; the chat on the card has four, one with no Contacts name.
    const withChat = group({ people: ["Sam", "Priya"], chat: hike() });
    expect(separatePlan(withChat.action.group!)).toEqual({ people: ["Sam Lee", "Priya Shah", "Jo Park"], skipped: [{ who: "+1 ••• ••• 0177", why: NO_NAME_COPY }] });
    const made = sendSeparately(db, withChat.action.id, "hi");
    expect(made.drafts.map((m) => m.toName)).toEqual(["Sam Lee", "Priya Shah", "Jo Park"]);
    expect(made.skipped).toEqual([{ who: "+1 ••• ••• 0177", why: NO_NAME_COPY }]);
    expect(activity()).toContain(`No separate text for +1 ••• ••• 0177: ${NO_NAME_COPY}`);
  });

});
