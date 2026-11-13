// The dashboard's "Remove old data": the list first, the removal only on a POST, and a notice Home can dismiss.
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../../src/engine/db";
import { startServer } from "../../src/server/server";
import { tempHome } from "../helpers";

let home: ReturnType<typeof tempHome>;
let db: Database;
let server: ReturnType<typeof startServer>;
let store: string;
let base: string;
beforeEach(() => {
  home = tempHome();
  store = join(home.home, "keychain.json");
  process.env.FAKE_SECURITY_STORE = store;
  writeFileSync(store, JSON.stringify({ "Atrium/finnhub.token": "abc123" }));
  db = openDb();
  server = startServer({ db, runner: { kick() {} }, setup: async () => { throw new Error("not used"); }, port: 0 });
  base = `http://127.0.0.1:${server.port}`;
});
afterEach(() => {
  server.stop(true);
  db.close();
  delete process.env.FAKE_SECURITY_STORE;
  delete process.env.FAKE_SECURITY_FAIL;
  home.cleanup();
});

const post = (path: string) => fetch(`${base}${path}`, { method: "POST", headers: { origin: base } });
const state = async () => (await (await fetch(`${base}/api/state`)).json()) as { oldData: { present: boolean; dismissed: boolean } };

test("a fresh install has no old data to offer", async () => {
  expect((await state()).oldData).toEqual({ present: false, dismissed: false });
  expect(await (await fetch(`${base}/api/old-data`)).json()).toBeNull();
});

test("an older install sees the list, and only the POST removes it", async () => {
  db.exec("CREATE TABLE tfsa_entries (id TEXT PRIMARY KEY, amount REAL); INSERT INTO tfsa_entries VALUES ('t1', 500)");
  expect((await state()).oldData).toEqual({ present: true, dismissed: false });
  const listed = await (await fetch(`${base}/api/old-data`)).json();
  expect(listed).toMatchObject({ groups: [{ label: "Money", tables: [{ name: "tfsa_entries", rows: 1 }] }], keychain: ["finnhub.token"] });
  expect(db.query("SELECT COUNT(*) AS n FROM tfsa_entries").get()).toEqual({ n: 1 });
  // A page on another site can't trigger it.
  expect((await fetch(`${base}/api/old-data/remove`, { method: "POST", headers: { origin: "https://example.com" } })).status).toBe(403);
  const res = await post("/api/old-data/remove");
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ keychain: ["finnhub.token"] });
  expect(JSON.parse(readFileSync(store, "utf8"))).toEqual({});
  expect((await state()).oldData.present).toBe(false);
});

test("a Keychain that refuses is a plain 409, and nothing is removed", async () => {
  db.exec("CREATE TABLE tfsa_entries (id TEXT PRIMARY KEY)");
  await fetch(`${base}/api/old-data`);
  process.env.FAKE_SECURITY_FAIL = "1";
  const res = await post("/api/old-data/remove");
  expect(res.status).toBe(409);
  expect((await res.json()).error).toContain("Keychain");
  expect((await state()).oldData.present).toBe(true);
});

test("Not now hides the Home notice and keeps the data", async () => {
  db.exec("CREATE TABLE tfsa_entries (id TEXT PRIMARY KEY)");
  expect((await post("/api/old-data/dismiss")).status).toBe(200);
  expect((await state()).oldData).toEqual({ present: true, dismissed: true });
});
