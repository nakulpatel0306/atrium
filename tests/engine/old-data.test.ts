// "Remove old data": what an older install's database and Keychain still hold from removed features, and removing
// it only when asked.
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../../src/engine/config";
import { openDb } from "../../src/engine/db";
import { findOldData, hasOldData, removeOldData } from "../../src/engine/old-data";
import { oldDataLines } from "../../src/engine/old-data-view";
import { getSetting, setSetting } from "../../src/engine/settings";
import { createTask } from "../../src/engine/tasks";
import { tempHome } from "../helpers";

const MARKER = "zebra-crossing-7731";
let home: ReturnType<typeof tempHome>;
let db: Database;
let store: string;
beforeEach(() => {
  home = tempHome();
  store = join(home.home, "keychain.json");
  process.env.FAKE_SECURITY_STORE = store;
  writeFileSync(
    store,
    JSON.stringify({
      "Atrium/google.refresh.acc_1": "aa11",
      "Atrium/google.client.secret": "bb22",
      "Atrium/finnhub.token": "cc33",
      "Atrium/projects.unrelated": "keep",
      "Other/finnhub.token": "keep",
    }),
  );
  db = openDb();
});
afterEach(() => {
  db.close();
  delete process.env.FAKE_SECURITY_STORE;
  delete process.env.FAKE_SECURITY_FAIL;
  home.cleanup();
});

// A database shaped like an older install: some of each removed feature's tables, settings and approvals.
function legacyInstall() {
  db.exec("PRAGMA ignore_check_constraints = ON");
  db.exec(`INSERT INTO spaces (id, name, kind, goal, color, private, status, created_at, updated_at) VALUES
    ('spc_inb', 'Inbox', 'inbox', '', '#fff', 1, 'active', 1, 1), ('spc_ok', 'Notes', 'general', '', '#fff', 0, 'active', 2, 2)`);
  db.exec("PRAGMA ignore_check_constraints = OFF");
  db.exec(`CREATE TABLE mail_accounts (id TEXT PRIMARY KEY, address TEXT);
    CREATE TABLE mail_messages (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES mail_accounts(id));
    CREATE TABLE mail_bodies (message_id TEXT PRIMARY KEY REFERENCES mail_messages(id), body TEXT);
    CREATE TABLE message_actions (id TEXT PRIMARY KEY, approval_id TEXT REFERENCES approvals(id), space_id TEXT REFERENCES spaces(id));
    CREATE TABLE tfsa_entries (id TEXT PRIMARY KEY, amount REAL);
    CREATE TABLE market_holdings (id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id), symbol TEXT);
    INSERT INTO mail_accounts VALUES ('acc_1', 'sam@example.com');
    INSERT INTO mail_messages VALUES ('m1', 'acc_1'), ('m2', 'acc_1');
    INSERT INTO mail_bodies VALUES ('m1', 'Dinner at 8, ${MARKER}');
    INSERT INTO tfsa_entries VALUES ('t1', 500);
    INSERT INTO market_holdings VALUES ('h1', 'spc_inb', 'SPY');`);
  db.exec("PRAGMA ignore_check_constraints = ON");
  db.exec(`INSERT INTO approvals (id, space_id, kind, title, detail, created_at, always_ask) VALUES ('apr_t', 'spc_ok', 'question', 'Send a text?', 'hey ${MARKER}', 1, 'send_message');
    INSERT INTO approvals (id, space_id, kind, title, detail, created_at) VALUES ('apr_a', 'spc_inb', 'alert', 'SPY above 600', '', 2);`);
  db.exec("PRAGMA ignore_check_constraints = OFF");
  db.exec("INSERT INTO message_actions VALUES ('x1', 'apr_t', 'spc_ok')");
  setSetting(db, "messaging.spaceId", "spc_ok");
  setSetting(db, "markets.provider", "finnhub");
  setSetting(db, "user.name", "Sam");
}

const tables = () => (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
const keychain = () => Object.keys(JSON.parse(readFileSync(store, "utf8")));
const onDisk = () => [config().dbPath, `${config().dbPath}-wal`].filter(existsSync).map((p) => readFileSync(p).toString("latin1")).join("");

test("a fresh install has no old data, and asks the Keychain nothing", async () => {
  process.env.FAKE_SECURITY_FAIL = "1";
  expect(hasOldData(db)).toBe(false);
  expect(await findOldData(db)).toBeNull();
  expect(await removeOldData(db)).toBeNull();
});

test("the list says exactly what would go, and finding it removes nothing", async () => {
  legacyInstall();
  expect(hasOldData(db)).toBe(true);
  const found = await findOldData(db);
  expect(found).toEqual({
    groups: [
      { label: "Mail and calendar", tables: [{ name: "mail_bodies", rows: 1 }, { name: "mail_messages", rows: 2 }, { name: "mail_accounts", rows: 1 }] },
      { label: "Texting", tables: [{ name: "message_actions", rows: 1 }] },
      { label: "Money", tables: [{ name: "tfsa_entries", rows: 1 }] },
      { label: "Markets and investing", tables: [{ name: "market_holdings", rows: 1 }] },
    ],
    settings: ["markets.provider", "messaging.spaceId"],
    approvals: 2,
    keychain: ["google.refresh.acc_1", "google.client.secret", "finnhub.token"],
    spaces: ["Inbox"],
  });
  expect(oldDataLines(found!)).toEqual([
    "Mail and calendar: 4 rows in mail_bodies (1), mail_messages (2), mail_accounts (1)",
    "Texting: 1 row in message_actions (1)",
    "Money: 1 row in tfsa_entries (1)",
    "Markets and investing: 1 row in market_holdings (1)",
    "Settings: markets.provider, messaging.spaceId",
    "Approvals nobody can act on: 2",
    'Keychain items (service "Atrium"): google.refresh.acc_1, google.client.secret, finnhub.token',
  ]);
  expect(tables()).toContain("mail_bodies");
  expect(keychain()).toHaveLength(5);
});

test("removing drops the old tables, settings, approvals and Atrium's Keychain items, and leaves no copy on disk", async () => {
  legacyInstall();
  const plain = createTask(db, { spaceId: "spc_ok", title: "Plain work" });
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  expect(onDisk()).toContain(MARKER);
  const removed = await removeOldData(db);
  expect(removed!.keychain).toHaveLength(3);
  expect(tables().filter((n) => /^(mail_|message_actions|tfsa_|market_)/.test(n))).toEqual([]);
  expect(keychain().sort()).toEqual(["Atrium/projects.unrelated", "Other/finnhub.token"]);
  expect(getSetting(db, "messaging.spaceId")).toBeNull();
  expect(getSetting(db, "user.name")).toBe("Sam");
  expect(db.query("SELECT COUNT(*) AS n FROM approvals").get()).toEqual({ n: 0 });
  // Spaces and tasks are the user's to delete; only the removed features' own data goes.
  expect(db.query("SELECT name FROM spaces ORDER BY created_at").all()).toEqual([{ name: "Inbox" }, { name: "Notes" }]);
  expect(db.query("SELECT id FROM tasks").all()).toEqual([{ id: plain.id }]);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(onDisk()).not.toContain(MARKER);
  expect(hasOldData(db)).toBe(false);
  expect(await findOldData(db)).toBeNull();
});

test("when the Keychain refuses, nothing in the database is removed", async () => {
  legacyInstall();
  // Finding works; the removal is what fails.
  const found = await findOldData(db);
  expect(found!.keychain).toHaveLength(3);
  process.env.FAKE_SECURITY_FAIL = "1";
  await expect(removeOldData(db)).rejects.toThrow("Couldn't read your Mac's Keychain");
  expect(tables()).toContain("mail_accounts");
  expect(getSetting(db, "markets.provider")).toBe("finnhub");
});

test("an older install that kept no Keychain items still removes its tables", async () => {
  writeFileSync(store, "{}");
  legacyInstall();
  const removed = await removeOldData(db);
  expect(removed!.keychain).toEqual([]);
  expect(hasOldData(db)).toBe(false);
});

test("a kept setting that only differs in case from an old prefix is never counted or removed", async () => {
  setSetting(db, "Mail.layout", "wide");
  expect(hasOldData(db)).toBe(false);
  legacyInstall();
  await removeOldData(db);
  expect(getSetting(db, "Mail.layout")).toBe("wide");
});
