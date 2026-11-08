import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../../../src/engine/db";
import { listActivity } from "../../../src/engine/events";
import { autoLookup, lookup, parseContacts } from "../../../src/engine/messaging/contacts";
import { MessagingProblem } from "../../../src/engine/messaging/problems";
import { draftMessage, getMessageAction } from "../../../src/engine/messaging/store";
import { getSetting, setSetting } from "../../../src/engine/settings";
import { createSpace, type Space } from "../../../src/engine/spaces";
import { tempHome } from "../../helpers";

let home: ReturnType<typeof tempHome>;
let db: Database;
let space: Space;
let log: string;
beforeEach(() => {
  home = tempHome();
  db = openDb();
  space = createSpace(db, { name: "Messages", kind: "general", goal: "" });
  log = join(home.home, "osa.log");
  process.env.FAKE_OSASCRIPT_LOG = log;
});
afterEach(() => {
  for (const k of ["FAKE_OSASCRIPT_LOG", "FAKE_OSASCRIPT_MODE", "FAKE_OSASCRIPT_CONTACTS"]) delete process.env[k];
  db.close();
  home.cleanup();
});

const contacts = (rows: string[][]) => (process.env.FAKE_OSASCRIPT_CONTACTS = JSON.stringify(rows));
const draft = (toName = "Dana") => draftMessage(db, { spaceId: space.id, toName, text: "you free sat?" }).action;
const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]) : []);

test("one person with one mobile is picked", async () => {
  contacts([["p1", "Dana Rivera", "phone", "_$!<Mobile>!$_", "+1 (555) 010-0134"]]);
  const a = draft();
  const res = await lookup(db, a.id);
  expect(res.picked).toBe("+15550100134");
  expect(res.candidates).toEqual([{ personId: "p1", name: "Dana Rivera", kind: "phone", label: "Mobile", handle: "+15550100134" }]);
  expect(getMessageAction(db, a.id)).toMatchObject({ handle: "+15550100134", handleSource: "contacts" });
  expect(getSetting(db, "messaging.contactsReady")).toBe("true");
});

test("several matches are listed, none picked", async () => {
  contacts([
    ["p1", "Dana Rivera", "phone", "_$!<Mobile>!$_", "+15550100134"],
    ["p2", "Dana Moreno", "phone", "missing value", "+15550109999"],
  ]);
  const two = await lookup(db, draft().id);
  expect(two.picked).toBeNull();
  expect(two.candidates.map((c) => [c.name, c.label])).toEqual([["Dana Rivera", "Mobile"], ["Dana Moreno", null]]);
  contacts([
    ["p1", "Dana", "phone", "home", "+15550100134"],
    ["p1", "Dana", "email", "work", "dana@example.com"],
    ["p1", "Dana", "phone", "other", "+1 555 010 0134"],
  ]);
  const a = draft();
  const mixed = await lookup(db, a.id);
  expect(mixed.picked).toBeNull();
  expect(mixed.candidates.map((c) => c.handle)).toEqual(["+15550100134", "dana@example.com"]);
  expect(getMessageAction(db, a.id)!.handle).toBeNull();
});

test("no match is an empty list", async () => {
  contacts([]);
  expect(await lookup(db, draft().id)).toEqual({ candidates: [], picked: null });
});

test("the query is the name exactly, as one argument", async () => {
  contacts([]);
  const name = 'Dana" & (do shell script "id") & "';
  await lookup(db, draft(name).id);
  const argv = calls()[0]!;
  expect(argv.slice(argv.indexOf("--") + 1)).toEqual([name]);
});

test("a separator inside contact data only loses that record", () => {
  const RS = "\u001e";
  const US = "\u001f";
  const out = [`p1${US}Da${RS}na${US}phone${US}Mobile${US}+15550100134`, `p2${US}Dana B${US}phone${US}Mobile${US}+15550109999`].join(RS);
  expect(parseContacts(`${out}\n`).map((c) => c.personId)).toEqual(["p2"]);
  expect(parseContacts(`p3${US}X${US}phone${US}Mobile${US}chat1234567`)).toEqual([]);
});

test("a denied lookup says so and remembers it", async () => {
  process.env.FAKE_OSASCRIPT_MODE = "denied";
  setSetting(db, "messaging.contactsReady", "true");
  const err = await lookup(db, draft().id).catch((e) => e);
  expect(err).toBeInstanceOf(MessagingProblem);
  expect(err.kind).toBe("contacts_denied");
  expect(getSetting(db, "messaging.contactsReady")).toBe("false");
});

test("autoLookup waits for Nakul's first lookup", async () => {
  contacts([["p1", "Dana", "phone", "Mobile", "+15550100134"]]);
  const a = draft();
  await autoLookup(db, a.id);
  expect(calls()).toEqual([]);
  setSetting(db, "messaging.contactsReady", "true");
  await autoLookup(db, a.id);
  expect(getMessageAction(db, a.id)!.handle).toBe("+15550100134");
  process.env.FAKE_OSASCRIPT_MODE = "fail";
  const b = draft();
  await autoLookup(db, b.id);
  expect(listActivity(db, { spaceId: space.id }).map((r) => r.message)).toContain(
    "Couldn't look up Dana in Contacts. Contacts didn't answer, and Atrium couldn't tell why. Type the number yourself, or look again.",
  );
});
