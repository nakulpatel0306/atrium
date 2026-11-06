import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Server } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getApproval, onApprovalResolved } from "../../src/engine/approvals";
import { openDb } from "../../src/engine/db";
import { createMessaging, type Messaging } from "../../src/engine/messaging";
import { PROBLEM_COPY, SETTINGS_PANES } from "../../src/engine/messaging/problems";
import { BAD_HANDLE_COPY, HIDDEN_COPY, TOO_LONG_COPY } from "../../src/engine/messaging/rules";
import { draftMessage, getMessageAction } from "../../src/engine/messaging/store";
import { createSpace, type Space } from "../../src/engine/spaces";
import type { State } from "../../src/engine/state";
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

beforeEach(() => {
  home = tempHome();
  db = openDb();
  osaLog = join(home.home, "osa.log");
  openLog = join(home.home, "open.log");
  process.env.FAKE_OSASCRIPT_LOG = osaLog;
  process.env.FAKE_OPEN_LOG = openLog;
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
  for (const k of ["FAKE_OSASCRIPT_LOG", "FAKE_OPEN_LOG", "FAKE_OSASCRIPT_MODE"]) delete process.env[k];
  db.close();
  home.cleanup();
});

const post = (path: string, body?: unknown, headers: Record<string, string> = { origin: base }) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body ?? {}) });
const errorOf = async (r: Response) => ((await r.json()) as { error: string }).error;
const sends = () => (existsSync(osaLog) ? readFileSync(osaLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]) : []);
const draft = () => draftMessage(db, { spaceId: space.id, toName: "Dana", text: "you free sat?" });
const fields = { text: "running 10 late", handle: "+1 555 010 0134", service: "iMessage" };

test("Send sends Nakul's edited text and records his yes", async () => {
  const { action, approval } = draft();
  const r = await post(`/api/message-actions/${action.id}/send`, fields);
  expect(r.status).toBe(200);
  await messaging.settle();
  expect(sends().map((a) => a.slice(a.indexOf("--") + 1))).toEqual([["iMessage", "+15550100134", "running 10 late"]]);
  expect(getApproval(db, approval.id)).toMatchObject({ status: "approved", decidedBy: "you" });
  expect(getMessageAction(db, action.id)!.status).toBe("sent");
});

test("bad input is refused and nothing is sent", async () => {
  const { action, approval } = draft();
  for (const [body, copy] of [
    [{ ...fields, handle: "-e" }, BAD_HANDLE_COPY],
    [{ ...fields, text: "a".repeat(2001) }, TOO_LONG_COPY],
    [{ ...fields, text: "a‮b" }, HIDDEN_COPY],
  ] as const) {
    const r = await post(`/api/message-actions/${action.id}/send`, body);
    expect(r.status).toBe(400);
    expect(await errorOf(r)).toBe(copy);
  }
  expect(getApproval(db, approval.id)!.status).toBe("pending");
  expect(sends()).toEqual([]);
});

test("a second Send is refused and sends nothing more", async () => {
  const { action } = draft();
  const [one, two] = await Promise.all([post(`/api/message-actions/${action.id}/send`, fields), post(`/api/message-actions/${action.id}/send`, fields)]);
  expect([one.status, two.status].sort()).toEqual([200, 409]);
  const again = await post(`/api/message-actions/${action.id}/send`, fields);
  expect(again.status).toBe(409);
  expect(await errorOf(again)).toBe("This item was already resolved. Refresh the Needs you list to see its current state.");
  await messaging.settle();
  expect(sends()).toHaveLength(1);
});

test("the generic approve is refused for a text; reject still works", async () => {
  const { action, approval } = draft();
  const yes = await post(`/api/approvals/${approval.id}`, { decision: "approve" });
  expect(yes.status).toBe(409);
  expect(await errorOf(yes)).toBe("Press Send on the message card, so Atrium sends exactly what you saw.");
  expect(getApproval(db, approval.id)!.status).toBe("pending");
  const no = await post(`/api/approvals/${approval.id}`, { decision: "reject" });
  expect(no.status).toBe(200);
  expect(getMessageAction(db, action.id)!.status).toBe("rejected");
  expect(sends()).toEqual([]);
});

test("a Send without our Origin is forbidden", async () => {
  const { action } = draft();
  expect((await post(`/api/message-actions/${action.id}/send`, fields, {})).status).toBe(403);
  expect((await post(`/api/message-actions/${action.id}/send`, fields, { origin: "http://evil.example" })).status).toBe(403);
  expect(sends()).toEqual([]);
});

test("an unknown draft is 404", async () => {
  const r = await post("/api/message-actions/msa_nope/send", fields);
  expect(r.status).toBe(404);
  expect(await errorOf(r)).toBe("No such message draft.");
});

test("lookup reports matches, and a denied lookup says how to allow it", async () => {
  const { action } = draft();
  process.env.FAKE_OSASCRIPT_CONTACTS = JSON.stringify([
    ["p1", "Dana A", "phone", "Mobile", "+15550100134"],
    ["p2", "Dana B", "phone", "Mobile", "+15550109999"],
  ]);
  try {
    const r = await post(`/api/message-actions/${action.id}/lookup`);
    const body = (await r.json()) as { candidates: unknown[]; picked: string | null; message: string };
    expect(body.candidates).toHaveLength(2);
    expect(body.picked).toBeNull();
    expect(body.message).toBe('More than one match for "Dana". Pick who this goes to.');
  } finally {
    delete process.env.FAKE_OSASCRIPT_CONTACTS;
  }
  process.env.FAKE_OSASCRIPT_MODE = "denied";
  const denied = await post(`/api/message-actions/${action.id}/lookup`);
  expect(denied.status).toBe(409);
  expect(await denied.json()).toEqual({ error: PROBLEM_COPY.contacts_denied, pane: "automation" });
});

test("open-settings opens only the Automation pane", async () => {
  expect((await post("/api/messaging/open-settings", { pane: "automation" })).status).toBe(200);
  expect(readFileSync(openLog, "utf8").trim()).toBe(JSON.stringify([SETTINGS_PANES.automation]));
  const bad = await post("/api/messaging/open-settings", { pane: "x" });
  expect(bad.status).toBe(400);
  expect(await errorOf(bad)).toBe("Atrium can only open the Automation settings.");
});

test("state and history carry the drafts", async () => {
  const { action } = draft();
  const state = (await (await fetch(`${base}/api/state`)).json()) as State;
  expect(state.messageActions).toEqual([
    expect.objectContaining({ id: action.id, toName: "Dana", handle: null, text: "you free sat?", service: "iMessage", lastError: null, contactsReady: false }),
  ]);
  await post(`/api/message-actions/${action.id}/send`, fields);
  await messaging.settle();
  const hist = (await (await fetch(`${base}/api/spaces/${space.id}/messages`)).json()) as { status: string }[];
  expect(hist.map((h) => h.status)).toEqual(["sent"]);
});

test("M3: the send listener runs after the Send transaction has committed", async () => {
  let inTx = null as boolean | null;
  const offA = onApprovalResolved(() => {
    inTx = db.inTransaction;
  });
  try {
    const { action } = draft();
    const r = await post(`/api/message-actions/${action.id}/send`, fields);
    expect(r.status).toBe(200);
    await messaging.settle();
    expect(inTx).toBe(false);
    expect(sends()).toHaveLength(1);
  } finally {
    offA();
  }
});
