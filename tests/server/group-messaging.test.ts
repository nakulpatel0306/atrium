import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Server } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getApproval, onApprovalResolved } from "../../src/engine/approvals";
import { openDb } from "../../src/engine/db";
import { createMessaging, type Messaging } from "../../src/engine/messaging";
import { CHAT_CHANGED_COPY, draftGroupMessage, draftMessage, getMessageAction, pendingMessageActions } from "../../src/engine/messaging/store";
import { NO_CHAT_COPY } from "../../src/engine/messaging/send";
import { FIND_COPY } from "../../src/engine/messaging/problems";
import { createSpace, type Space } from "../../src/engine/spaces";
import type { State } from "../../src/engine/state";
import { PICK_AGAIN_COPY } from "../../src/engine/messaging";
import { startServer, type WsData } from "../../src/server/server";
import { tempHome } from "../helpers";

let home: ReturnType<typeof tempHome>;
let db: Database;
let messaging: Messaging;
let server: Server<WsData>;
let base: string;
let space: Space;
let off: () => void;
let osaLog: string;
let openLog: string;

const CHATS = [
  ["iMessage;+;chat-hike", "Hike crew", "iMessage", [["+14165550134", "Sam Lee"], ["priya@example.com", "Priya Shah"]]],
  ["iMessage;+;chat-book", "Book club", "iMessage", [["+14165550111", "Ann"], ["+14165550122", "Bo"]]],
];

beforeEach(() => {
  home = tempHome();
  db = openDb();
  osaLog = join(home.home, "osa.log");
  openLog = join(home.home, "open.log");
  process.env.FAKE_OSASCRIPT_LOG = osaLog;
  process.env.FAKE_OPEN_LOG = openLog;
  process.env.FAKE_OSASCRIPT_CHATS = JSON.stringify(CHATS);
  messaging = createMessaging({ db, kick: () => {} });
  off = onApprovalResolved(messaging.onDecision);
  server = startServer({ db, runner: { kick: () => {} }, setup: async () => { throw new Error("no setup"); }, port: 0, messaging });
  base = `http://127.0.0.1:${server.port}`;
  space = createSpace(db, { name: "Messages", kind: "general", goal: "" });
});
afterEach(async () => {
  await messaging.settle();
  off();
  server.stop(true);
  for (const k of ["FAKE_OSASCRIPT_LOG", "FAKE_OPEN_LOG", "FAKE_OSASCRIPT_MODE", "FAKE_OSASCRIPT_CHATS"]) delete process.env[k];
  db.close();
  home.cleanup();
});

const post = (path: string, body?: unknown, headers: Record<string, string> = { origin: base }) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body ?? {}) });
const errorOf = async (r: Response) => ((await r.json()) as { error: string }).error;
const calls = () => (existsSync(osaLog) ? readFileSync(osaLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]) : []);
const chatSends = () => calls().filter((a) => a.includes("set target to chat id chatId")).map((a) => a.slice(a.indexOf("--") + 1));
const group = (name: string | null = "hike", people: string[] = []) => draftGroupMessage(db, { spaceId: space.id, name, people, text: "lock in saturday?" });
type Found = { chats: { id: string; name: string | null; participants: { name: string | null; handle: string }[] }[]; picked: string | null; message: string | null };

test("Find lists the chats with masked handles, and Send goes to the one he picked", async () => {
  const { action, approval } = group();
  expect(calls()).toEqual([]);
  const send = await post(`/api/message-actions/${action.id}/send`, { text: "x", chatId: "iMessage;+;chat-hike" });
  expect([send.status, await errorOf(send)]).toEqual([400, NO_CHAT_COPY]);
  const r = await post(`/api/message-actions/${action.id}/find-chat`);
  const found = (await r.json()) as Found;
  expect(found.picked).toBeNull();
  expect(found.message).toBe('No group chat is exactly "hike". The closest one is first. Pick it if it\'s right.');
  expect(found.chats.map((c) => c.name)).toEqual(["Hike crew", "Book club"]);
  expect(JSON.stringify(found)).not.toContain("4165550134");
  expect(found.chats[0]!.participants[1]).toEqual({ name: "Priya Shah", handle: "p••@example.com" });

  const made = await post(`/api/message-actions/${action.id}/chat`, { chatId: "iMessage;+;chat-made-up" });
  expect([made.status, await errorOf(made)]).toEqual([400, PICK_AGAIN_COPY]);
  const pick = await post(`/api/message-actions/${action.id}/chat`, { chatId: "iMessage;+;chat-hike" });
  expect(pick.status).toBe(200);
  const state = (await (await fetch(`${base}/api/state`)).json()) as State;
  expect(state.messageActions[0]!.group).toMatchObject({ name: "hike", chat: { id: "iMessage;+;chat-hike", name: "Hike crew" } });
  expect(state.approvals.find((a) => a.id === approval.id)!.title).toBe("Send a text to Hike crew?");

  // A Send for a chat the card no longer shows decides nothing.
  const stale = await post(`/api/message-actions/${action.id}/send`, { text: "lock in sat, 8am?", chatId: "iMessage;+;chat-book" });
  expect([stale.status, await errorOf(stale)]).toEqual([400, CHAT_CHANGED_COPY]);
  expect(getApproval(db, approval.id)!.status).toBe("pending");
  const yes = { text: "lock in sat, 8am?", chatId: "iMessage;+;chat-hike" };
  const [one, two] = await Promise.all([post(`/api/message-actions/${action.id}/send`, yes), post(`/api/message-actions/${action.id}/send`, yes)]);
  expect([one.status, two.status].sort()).toEqual([200, 409]);
  await messaging.settle();
  expect(chatSends()).toEqual([["iMessage;+;chat-hike", "lock in sat, 8am?"]]);
  expect(getApproval(db, approval.id)).toMatchObject({ status: "approved", decidedBy: "you" });
});

test("a clear match is picked by Find on its own", async () => {
  const { action } = group("Book club");
  const found = (await (await post(`/api/message-actions/${action.id}/find-chat`)).json()) as Found;
  expect([found.picked, found.message]).toEqual(["iMessage;+;chat-book", null]);
  expect(getMessageAction(db, action.id)!.group!.chat!.name).toBe("Book club");
});

test("Find denied says how to allow it; Find on a person text is 404", async () => {
  process.env.FAKE_OSASCRIPT_MODE = "denied";
  const { action } = group();
  const denied = await post(`/api/message-actions/${action.id}/find-chat`);
  expect(denied.status).toBe(409);
  expect(await denied.json()).toEqual({ error: FIND_COPY.automation_denied, pane: "automation" });
  const one = draftMessage(db, { spaceId: space.id, toName: "Dana", text: "hi" });
  expect((await post(`/api/message-actions/${one.action.id}/find-chat`)).status).toBe(404);
});

test("Send separately makes per-person drafts and sends nothing", async () => {
  const { action, approval } = group(null, ["Sam", "Priya"]);
  const r = await post(`/api/message-actions/${action.id}/separately`, { text: "edited" });
  expect(r.status).toBe(200);
  const { drafts } = (await r.json()) as { drafts: { toName: string; text: string }[] };
  expect(drafts.map((d) => [d.toName, d.text])).toEqual([["Sam", "edited"], ["Priya", "edited"]]);
  expect(getApproval(db, approval.id)!.status).toBe("rejected");
  expect(pendingMessageActions(db).map((m) => m.toName)).toEqual(["Sam", "Priya"]);
  const again = await post(`/api/message-actions/${action.id}/separately`, { text: "edited" });
  expect(again.status).toBe(409);
  const bad = group(null, ["Jo", "Dev"]);
  expect((await post(`/api/message-actions/${bad.action.id}/separately`, { text: "a‮b" })).status).toBe(400);
  expect(getMessageAction(db, bad.action.id)!.status).toBe("draft");
  await messaging.settle();
  expect(calls()).toEqual([]);
});

test("a group Send without our Origin is forbidden", async () => {
  const { action } = group();
  for (const path of ["find-chat", "chat", "separately", "send"]) {
    expect((await post(`/api/message-actions/${action.id}/${path}`, { text: "x", chatId: "x" }, {})).status).toBe(403);
  }
  expect(calls()).toEqual([]);
});
