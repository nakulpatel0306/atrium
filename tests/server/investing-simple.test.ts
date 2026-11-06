import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDb } from "../../src/engine/db";
import { setSetting } from "../../src/engine/settings";
import { createSpace } from "../../src/engine/spaces";
import { isAdvanced } from "../../src/engine/markets/advanced";
import { createMarketData } from "../../src/engine/markets/data";
import { createFeed } from "../../src/engine/markets/feed";
import { createKeychain } from "../../src/engine/markets/keychain";
import { listLists } from "../../src/engine/markets/lists";
import { demoProvider } from "../../src/engine/markets/providers/demo";
import { startServer } from "../../src/server/server";
import { NOW, simpleFixture } from "../engine/markets/simple-fixture";
import { tempHome } from "../helpers";

const FAKE = resolve(import.meta.dir, "../fixtures/fake-security.ts");

let home: ReturnType<typeof tempHome>;
let keyDir: string;
let db: Database;
let server: ReturnType<typeof startServer>;
let base: string;
let fetchCalls: string[];
let reevaluated: number;

function boot() {
  setSetting(db, "markets.provider", "demo");
  const keychain = createKeychain(FAKE);
  const clock = () => NOW;
  const stub = (async (input: string | URL | Request) => {
    fetchCalls.push(String(input instanceof Request ? input.url : input));
    throw new Error("no network in this test");
  }) as unknown as typeof fetch;
  const data = createMarketData({ db, keychain, now: clock, fetch: stub, providers: { demo: demoProvider({ now: clock }) } });
  const real = createFeed({ db, data, onQuotes: () => {}, strategyActive: () => false, now: clock });
  const feed = { ...real, reevaluate: async () => void reevaluated++ };
  server = startServer({ db, runner: { kick: () => {} }, setup: async () => { throw new Error("no"); }, port: 0, markets: { data, feed, keychain, kick: () => {}, now: clock, fetch: stub } });
  base = `http://127.0.0.1:${server.port}`;
}

beforeEach(() => {
  home = tempHome();
  keyDir = mkdtempSync(join(tmpdir(), "atrium-keys-"));
  process.env.FAKE_SECURITY_STORE = join(keyDir, "store.json");
  db = openDb();
  fetchCalls = [];
  reevaluated = 0;
});
afterEach(() => {
  server?.stop(true);
  db.close();
  delete process.env.FAKE_SECURITY_STORE;
  rmSync(keyDir, { recursive: true, force: true });
  home.cleanup();
});

const call = (method: string, path: string, body?: unknown) =>
  fetch(base + path, { method, headers: { origin: base, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const get = (path: string) => fetch(base + path);
const error = async (r: Response) => [r.status, ((await r.json()) as { error: string }).error];

test("the Advanced switch flips per space", async () => {
  const { spaceId } = simpleFixture(db);
  boot();
  expect(await (await call("PUT", `/api/investing/${spaceId}/advanced`, { on: true })).json()).toEqual({ advanced: true });
  expect(isAdvanced(db, spaceId)).toBe(true);
  expect(reevaluated).toBe(1);
  expect(await (await call("PUT", `/api/investing/${spaceId}/advanced`, { on: false })).json()).toEqual({ advanced: false });
  expect(isAdvanced(db, spaceId)).toBe(false);
  expect(await error(await call("PUT", `/api/investing/${spaceId}/advanced`, { on: "yes" }))).toEqual([400, "on must be true or false."]);
});

test("every view is a GET that reads SQLite only", async () => {
  const { spaceId } = simpleFixture(db);
  boot();
  const p = await (await get(`/api/investing/${spaceId}/portfolio`)).json();
  expect(p.holdings.map((h: { key: string }) => h.key).sort()).toEqual(["AMZN", "XEQT.TO"]);
  const l = await (await get(`/api/investing/${spaceId}/lists`)).json();
  expect(l.lists.map((x: { name: string }) => x.name)).toEqual(["Holdings"]);
  expect((await (await get(`/api/investing/${spaceId}/earnings`)).json()).rows).toEqual([]);
  const g = await (await get(`/api/investing/${spaceId}/glance`)).json();
  expect(g.advanced).toBe(false);
  expect(fetchCalls).toEqual([]);
});

test("lists and items round-trip with plain refusals", async () => {
  const { spaceId, holdingsList } = simpleFixture(db);
  boot();
  const ideas = await (await call("POST", `/api/investing/${spaceId}/lists`, { name: "Ideas" })).json();
  expect(ideas).toMatchObject({ name: "Ideas", position: 1 });
  expect(await error(await call("POST", `/api/investing/${spaceId}/lists`, { name: "" }))).toEqual([400, "Name the list, like Holdings or Ideas."]);
  expect((await (await call("PATCH", `/api/investing/${spaceId}/lists/${ideas.id}`, { name: "Maybe" })).json()).name).toBe("Maybe");
  const item = await (await call("POST", `/api/investing/${spaceId}/lists/${ideas.id}/items`, { key: "shop.to", name: "Shopify" })).json();
  expect(item).toMatchObject({ key: "SHOP.TO", name: "Shopify" });
  expect(await error(await call("POST", `/api/investing/${spaceId}/lists/${ideas.id}/items`, { key: "not a key!" }))).toEqual([400, "Type a symbol like AAPL or SHOP.TO."]);
  expect((await call("DELETE", `/api/investing/${spaceId}/lists/${ideas.id}/items/SHOP.TO`)).status).toBe(200);
  expect((await call("DELETE", `/api/investing/${spaceId}/lists/${ideas.id}`)).status).toBe(200);
  expect(await error(await call("DELETE", `/api/investing/${spaceId}/lists/${holdingsList}`))).toEqual([400, "Keep at least one list. Make a new one before deleting this."]);
  expect(listLists(db, spaceId).map((x) => x.name)).toEqual(["Holdings"]);
});

test("a list from another space, or a space that isn't markets, is a 404", async () => {
  const { spaceId } = simpleFixture(db);
  const other = createSpace(db, { name: "Ideas", kind: "markets", goal: "g" });
  const general = createSpace(db, { name: "Docs", kind: "general", goal: "g" });
  boot();
  const theirs = await (await call("POST", `/api/investing/${other.id}/lists`, { name: "Theirs" })).json();
  expect(await error(await call("PATCH", `/api/investing/${spaceId}/lists/${theirs.id}`, { name: "Mine" }))).toEqual([404, "No such list in this space."]);
  expect(await error(await call("POST", `/api/investing/${spaceId}/lists/${theirs.id}/items`, { key: "AAPL" }))).toEqual([404, "No such list in this space."]);
  expect(await error(await call("DELETE", `/api/investing/${spaceId}/lists/lst_nope`))).toEqual([404, "No such list in this space."]);
  expect(await error(await get(`/api/investing/${general.id}/portfolio`))).toEqual([404, "No such markets space."]);
  expect(await error(await get(`/api/investing/spc_missing/lists`))).toEqual([404, "No such markets space."]);
});
