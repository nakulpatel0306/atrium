import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Server } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../../src/engine/db";
import { mailKeychain } from "../../src/engine/mail/google/oauth";
import { listAccounts, listThreads, threadMessages } from "../../src/engine/mail/store";
import { createMail, type Mail } from "../../src/engine/mail";
import type { MailOverview } from "../../src/server/mail";
import { getSpace } from "../../src/engine/spaces";
import { startServer, type WsData } from "../../src/server/server";
import { tempHome } from "../helpers";
import { approveInBrowser, CLIENT_ID, FAKE_SECURITY, useFakes } from "../engine/mail/fakes";
import { SAM, T0 } from "../engine/mail/helpers";

let home: ReturnType<typeof tempHome>;
let db: Database;
let server: Server<WsData>;
let base: string;
let fakes: ReturnType<typeof useFakes>;
let mail: Mail;
let openLog: string;
let clients: number[];
const NOW = T0 + 5 * 86_400_000;

beforeEach(() => {
  home = tempHome();
  db = openDb();
  fakes = useFakes();
  openLog = join(home.home, "open.log");
  process.env.FAKE_OPEN_LOG = openLog;
  mail = createMail({ db, keychain: mailKeychain(FAKE_SECURITY), now: () => NOW });
  clients = [];
  server = startServer({ db, runner: { kick: () => {} }, setup: async () => { throw new Error("no setup"); }, port: 0, mail, onClients: (n) => clients.push(n) });
  base = `http://127.0.0.1:${server.port}`;
});
afterEach(() => {
  server.stop(true);
  mail.sync.stop();
  delete process.env.FAKE_OPEN_LOG;
  fakes.undo();
  db.close();
  home.cleanup();
});

const send = (method: string, path: string, body?: unknown) =>
  fetch(base + path, { method, headers: { "content-type": "application/json", origin: base }, body: body === undefined ? undefined : JSON.stringify(body) });
const get = async <T>(path: string) => (await (await fetch(base + path)).json()) as T;
const errorOf = async (r: Response) => ((await r.json()) as { error: string }).error;
// What the thread view does: open the thread (bodies fetch in the background), then read it once they've landed.
async function openThread<T>(id: string): Promise<T> {
  expect((await send("POST", `/api/mail/threads/${id}/open`, {})).status).toBe(200);
  await mail.sync.fetchBodies(listThreadMessages(id));
  return get<T>(`/api/mail/threads/${id}`);
}
const listThreadMessages = (id: string) => threadMessages(db, id).map((m) => m.id);
const opened = () => (existsSync(openLog) ? readFileSync(openLog, "utf8") : "");

async function connectGoogle() {
  const r = await send("POST", "/api/mail/google/connect", { clientId: CLIENT_ID });
  expect(r.status).toBe(200);
  const { url } = (await r.json()) as { url: string };
  // The engine opened the sign-in page in the browser.
  expect(opened()).toContain("code_challenge");
  await approveInBrowser(url);
  while (!listAccounts(db).length) await Bun.sleep(5);
  await mail.sync.syncNow();
}

test("an empty home answers every read with nothing, and makes no space", async () => {
  const o = await get<MailOverview>("/api/mail");
  expect(o).toMatchObject({ spaceId: null, accounts: [], calendars: [], google: { clientId: null }, syncedAt: null });
  expect(o.apple).toMatchObject({ mail: false, calendar: false, mailProblem: null });
  expect(await get("/api/mail/threads")).toEqual({ threads: [] });
  expect(await get(`/api/mail/events?from=${NOW}&to=${NOW + 86_400_000}`)).toEqual({ events: [] });
  expect((await send("POST", "/api/mail/sync", {})).status).toBe(200);
  expect(listAccounts(db)).toEqual([]);
});

test("connecting Google makes the private Inbox space and fills it; the thread view fetches bodies", async () => {
  await connectGoogle();
  const o = await get<MailOverview>("/api/mail");
  expect(o.accounts.map((a) => a.address)).toEqual([SAM]);
  const space = getSpace(db, o.spaceId!)!;
  expect(space).toMatchObject({ name: "Inbox", kind: "inbox", private: true });
  // It can't be made public.
  const pub = await send("PATCH", `/api/spaces/${space.id}`, { private: false });
  expect(pub.status).toBe(400);
  expect(await errorOf(pub)).toBe("The Inbox stays private: your mail and calendar only go to Claude.");

  const needs = await get<{ threads: { subject: string }[] }>("/api/mail/threads?filter=unread");
  expect(needs.threads.map((t) => t.subject)).toEqual(["This week's deals"]);
  const lease = listThreads(db).find((t) => t.subject === "Lease renewal")!;
  // A plain read fetches nothing: the bodies come from opening the thread.
  const before = await get<{ messages: { body: string | null }[] }>(`/api/mail/threads/${lease.id}`);
  expect(before.messages.every((m) => m.body === null)).toBe(true);
  const detail = await openThread<{ messages: { body: string | null; attachments: { name: string; size: number; openable: boolean }[] }[]; loading: boolean; problem: string | null }>(lease.id);
  expect(detail.loading).toBe(false);
  expect(detail.problem).toBeNull();
  expect(detail.messages[1]!.body).toContain("Can we sign Thursday?");
  expect(detail.messages[1]!.attachments).toEqual([{ name: "lease.pdf", size: 15, openable: true }]);
});

test("an attachment opens through the engine's named-app path", async () => {
  await connectGoogle();
  const lease = listThreads(db).find((t) => t.subject === "Lease renewal")!;
  const detail = await openThread<{ messages: { id: string }[] }>(lease.id);
  const r = await send("POST", `/api/mail/messages/${detail.messages[1]!.id}/attachments/0/open`, { how: "open" });
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ app: "Preview" });
  expect(opened()).toContain("Preview");
});

test("account changes: colour must be one of the list, and Disconnect removes the token and cached mail", async () => {
  await connectGoogle();
  const [a] = listAccounts(db);
  expect((await send("PATCH", `/api/mail/accounts/${a!.id}`, { color: "red" })).status).toBe(400);
  expect((await send("PATCH", `/api/mail/accounts/${a!.id}`, { color: "#d96b8a" })).status).toBe(200);
  expect(listAccounts(db)[0]!.color).toBe("#d96b8a");
  // An attachment opened before the disconnect goes with the account.
  const lease = listThreads(db).find((t) => t.subject === "Lease renewal")!;
  const detail = await openThread<{ messages: { id: string }[] }>(lease.id);
  expect((await send("POST", `/api/mail/messages/${detail.messages[1]!.id}/attachments/0/open`, { how: "reveal" })).status).toBe(200);
  expect(existsSync(join(home.home, "mail-attachments", a!.id))).toBe(true);
  const r = await send("DELETE", `/api/mail/accounts/${a!.id}`);
  expect(r.status).toBe(200);
  expect(listAccounts(db)).toEqual([]);
  expect(listThreads(db)).toEqual([]);
  expect(existsSync(join(home.home, "mail-attachments", a!.id))).toBe(false);
  const keychain = JSON.parse(readFileSync(fakes.keychainFile, "utf8")) as Record<string, string>;
  expect(Object.keys(keychain).some((k) => k.includes("refresh"))).toBe(false);
});

test("a bad client ID and bad windows get plain errors", async () => {
  const r = await send("POST", "/api/mail/google/connect", { clientId: "oops" });
  expect(r.status).toBe(502);
  expect(await errorOf(r)).toContain("Google OAuth client ID");
  const w = await send("PUT", "/api/mail/settings", { mailDays: 0 });
  expect(w.status).toBe(400);
  expect(await errorOf(w)).toBe("mailDays must be a whole number from 1 to 365.");
  expect((await send("PUT", "/api/mail/settings", { mailDays: 14 })).status).toBe(200);
  expect((await get<MailOverview>("/api/mail")).settings.mailDays).toBe(14);
});

test("Apple Mail and Calendar turn on through the helper and fill the Inbox", async () => {
  const r = await send("POST", "/api/mail/apple", { what: "mail" });
  expect(r.status).toBe(200);
  await send("POST", "/api/mail/apple", { what: "calendar" });
  const o = await get<MailOverview>("/api/mail");
  expect(o.apple).toMatchObject({ mail: true, calendar: true, mailProblem: null });
  expect(o.spaceId).not.toBeNull();
  expect(listThreads(db).map((t) => t.subject)).toContain("Trip plan");
  const off = await send("POST", "/api/mail/apple", { what: "mail", on: false });
  expect(off.status).toBe(200);
  expect(listAccounts(db)).toEqual([]);
});

test("each socket counts as a connected client, which is what drives the sync timer", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?events=changed`, { headers: { origin: base } } as unknown as string[]);
  await new Promise((r) => (ws.onopen = r));
  expect(clients.at(-1)).toBe(1);
  ws.close();
  while (clients.at(-1) !== 0) await Bun.sleep(5);
});
