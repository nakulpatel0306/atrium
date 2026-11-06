import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDb } from "../../src/engine/db";
import { setSetting } from "../../src/engine/settings";
import { createSpace } from "../../src/engine/spaces";
import { createMarketData } from "../../src/engine/markets/data";
import { createFeed } from "../../src/engine/markets/feed";
import { createKeychain } from "../../src/engine/markets/keychain";
import { demoProvider } from "../../src/engine/markets/providers/demo";
import { startServer } from "../../src/server/server";
import { tempHome } from "../helpers";

const FAKE = resolve(import.meta.dir, "../fixtures/fake-security.ts");
const DIR = resolve(import.meta.dir, "../fixtures/money");
const NOW = Date.parse("2026-11-05T16:00:00Z");

let home: ReturnType<typeof tempHome>;
let keyDir: string;
let db: Database;
let server: ReturnType<typeof startServer>;
let base: string;
let fetchCalls: string[];
let kicks: number;
let spaceId: string;

beforeEach(() => {
  home = tempHome();
  keyDir = mkdtempSync(join(tmpdir(), "atrium-keys-"));
  process.env.FAKE_SECURITY_STORE = join(keyDir, "store.json");
  db = openDb();
  fetchCalls = [];
  kicks = 0;
  setSetting(db, "markets.provider", "demo");
  const stub = (async (input: string | URL | Request) => {
    fetchCalls.push(String(input));
    throw new Error("no network");
  }) as unknown as typeof fetch;
  const keychain = createKeychain(FAKE);
  const data = createMarketData({ db, keychain, now: () => NOW, fetch: stub, providers: { demo: demoProvider({ now: () => NOW }) } });
  const feed = createFeed({ db, data, onQuotes: () => {}, strategyActive: () => false, now: () => NOW });
  server = startServer({ db, runner: { kick: () => {} }, setup: async () => { throw new Error("no"); }, port: 0, markets: { data, feed, keychain, kick: () => void kicks++, now: () => NOW, fetch: stub } });
  base = `http://127.0.0.1:${server.port}`;
  spaceId = createSpace(db, { name: "Investing", kind: "markets", goal: "g" }).id;
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
const money = (rest = "") => `/api/investing/${spaceId}/money${rest}`;
const csv = (name: string) => readFileSync(join(DIR, name), "utf8");

test("preview, import twice, then read the month — all without the network", async () => {
  const p = await (await call("POST", money("/preview"), { csv: csv("rbc.csv") })).json();
  expect(p).toMatchObject({ format: "bank", total: 40, signs: "negative-out" });
  expect(p.rows).toHaveLength(20);
  expect(await (await call("POST", money("/import"), { csv: csv("rbc.csv") })).json()).toMatchObject({ added: 40, duplicates: 0 });
  expect(await (await call("POST", money("/import"), { csv: csv("rbc.csv") })).json()).toMatchObject({ added: 0, duplicates: 40 });
  const v = await (await fetch(base + money("?month=2026-10"))).json();
  expect(v.month).toBe("2026-10");
  expect(v.spending.length).toBeGreaterThan(0);
  expect(v.starters).toHaveLength(4);
  expect(fetchCalls).toEqual([]);
});

test("bad input says what to do", async () => {
  const empty = await call("POST", money("/import"), { csv: "" });
  expect([empty.status, (await empty.json()).error]).toEqual([400, "Pick a CSV file or paste its contents."]);
  const unusable = await call("POST", money("/import"), { csv: "Name,Colour\nA,Red\n" });
  expect([unusable.status, (await unusable.json()).error]).toEqual([400, "Atrium couldn't find date, description and amount columns. Pick them below."]);
  const big = await call("POST", money("/preview"), { csv: "x".repeat(2 * 1024 * 1024 + 1) });
  expect(big.status).toBe(413);
});

test("rules can be read and replaced; the ask queues a Claude task", async () => {
  expect((await (await fetch(base + money("/rules"))).json()).length).toBeGreaterThan(10);
  expect(await (await call("PUT", money("/rules"), { rules: [{ match: "best buy", category: "Electronics" }] })).json()).toEqual([{ match: "best buy", category: "Electronics" }]);
  const bad = await call("PUT", money("/rules"), { rules: [{ match: "", category: "X" }] });
  expect(bad.status).toBe(400);
  const r = await (await call("POST", money("/ask"), { question: "Where did my money go last month?" })).json();
  expect(r.taskId).toMatch(/^tsk_/);
  expect(kicks).toBe(1);
  const again = await call("POST", money("/ask"), { question: "Again" });
  expect([again.status, (await again.json()).error]).toEqual([400, "Claude is already looking at your money."]);
});

test("a space that isn't markets has no money view", async () => {
  const general = createSpace(db, { name: "Docs", kind: "general", goal: "g" });
  const r = await fetch(`${base}/api/investing/${general.id}/money`);
  expect([r.status, (await r.json()).error]).toEqual([404, "No such markets space."]);
});

test("an oversized body is refused before it's parsed, with or without a Content-Length", async () => {
  const huge = JSON.stringify({ csv: "x".repeat(5 * 1024 * 1024) });
  const sized = await call("POST", money("/preview"), JSON.parse(huge));
  expect([sized.status, (await sized.json()).error]).toEqual([413, "That file is over 2 MB; export a shorter date range."]);
  // Streamed with no Content-Length: reading stops at the limit instead of taking in the whole body.
  const { readBody } = await import("../../src/server/http");
  const chunk = new Uint8Array(65536).fill(120);
  let pulled = 0;
  const stream = new ReadableStream({
    pull(c) {
      pulled++;
      if (pulled > 200) c.close();
      else c.enqueue(chunk);
    },
  });
  const req = new Request("http://127.0.0.1/x", { method: "POST", headers: { "content-type": "application/json" }, body: stream, duplex: "half" } as RequestInit);
  const err = await readBody(req, { bytes: 1024 * 1024, message: "too big" }).catch((e) => e);
  expect([err.status, err.message]).toEqual([413, "too big"]);
  expect(pulled).toBeLessThan(40);
});
