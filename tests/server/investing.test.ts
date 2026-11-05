import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDb } from "../../src/engine/db";
import { setSetting } from "../../src/engine/settings";
import { createSpace } from "../../src/engine/spaces";
import { listTasks } from "../../src/engine/tasks";
import { saveQuotes } from "../../src/engine/markets/cache";
import { recordCloses } from "../../src/engine/markets/closes";
import { createMarketData } from "../../src/engine/markets/data";
import { createFeed } from "../../src/engine/markets/feed";
import { parseIshares } from "../../src/engine/markets/funds/parse-ishares";
import { parseSsga } from "../../src/engine/markets/funds/parse-ssga";
import { saveFundFile } from "../../src/engine/markets/funds/store";
import { saveFx } from "../../src/engine/markets/fx";
import { addHolding } from "../../src/engine/markets/holdings";
import { createJobs } from "../../src/engine/markets/jobs";
import { createKeychain } from "../../src/engine/markets/keychain";
import { demoProvider } from "../../src/engine/markets/providers/demo";
import { startServer } from "../../src/server/server";
import { tempHome } from "../helpers";

const FAKE = resolve(import.meta.dir, "../fixtures/fake-security.ts");
const DIR = resolve(import.meta.dir, "../fixtures/markets/investing");
const NOW = Date.parse("2026-11-05T16:00:00Z");

let home: ReturnType<typeof tempHome>;
let keyDir: string;
let db: Database;
let server: ReturnType<typeof startServer>;
let base: string;
let fetchCalls: string[];
let allowFetch: boolean;

function boot() {
  setSetting(db, "markets.provider", "demo");
  const keychain = createKeychain(FAKE);
  const clock = () => NOW;
  const stub = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    fetchCalls.push(url.href);
    if (!allowFetch) throw new Error(`unexpected fetch ${url.href}`);
    return new Response(readFileSync(join(DIR, "ishares-xeqt.csv")));
  }) as unknown as typeof fetch;
  const data = createMarketData({ db, keychain, now: clock, fetch: stub, providers: { demo: demoProvider({ now: clock }) } });
  const feed = createFeed({ db, data, onQuotes: () => {}, strategyActive: () => false, now: clock });
  const jobs = createJobs(db, [], clock);
  server = startServer({ db, runner: { kick: () => {} }, setup: async () => { throw new Error("no"); }, port: 0, markets: { data, feed, keychain, kick: () => {}, now: clock, fetch: stub, jobs } });
  base = `http://127.0.0.1:${server.port}`;
}

beforeEach(() => {
  home = tempHome();
  keyDir = mkdtempSync(join(tmpdir(), "atrium-keys-"));
  process.env.FAKE_SECURITY_STORE = join(keyDir, "store.json");
  db = openDb();
  fetchCalls = [];
  allowFetch = false;
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

function investing() {
  const s = createSpace(db, { name: "Investing", kind: "markets", goal: "g" });
  for (const [symbol, exchange, qty, ccy] of [["NOW", "US", 2, "USD"], ["SPY", "US", 3, "USD"], ["XEQT", "TSX", 40, "CAD"], ["VFV", "TSX", 10, "CAD"]] as const) {
    addHolding(db, s.id, { account: "TFSA", symbol, exchange, name: symbol, quantity: qty, bookValue: 100 * qty, currency: ccy });
  }
  saveFx(db, [{ date: "2026-11-04", rate: 1.3961 }]);
  saveQuotes(db, ["NOW", "SPY", "XEQT.TO", "VFV.TO"].map((key, i) => ({ key, price: 100 + i, prevClose: 99 + i, at: NOW, source: "demo" as const, freshness: "demo" as const })));
  saveFundFile(db, parseSsga(new Uint8Array(readFileSync(join(DIR, "ssga-spy.xlsx"))), "SPY"), NOW - 10 * 86_400_000);
  saveFundFile(db, parseIshares(readFileSync(join(DIR, "ishares-xeqt.csv"), "utf8"), "XEQT.TO", "ishares-ca"), NOW - 10 * 86_400_000);
  return s;
}

test("health reads the DB: CAD total at the Bank of Canada rate, four periods, a row per held fund", async () => {
  boot();
  const s = investing();
  const r = await get(`/api/investing/${s.id}/health`);
  expect(r.status).toBe(200);
  const body = await r.json();
  expect(body.health.totalCad.source).toContain("Bank of Canada");
  expect(body.performance.map((p: { period: string }) => p.period)).toEqual(["1M", "3M", "YTD", "1Y"]);
  expect(body.funds.map((f: { key: string }) => f.key).sort()).toEqual(["SPY", "VFV.TO", "XEQT.TO"]);
  expect(body.funds.find((f: { key: string }) => f.key === "XEQT.TO")).toMatchObject({ asOf: "2026-11-04", source: "iShares holdings file · Nov 4", lastError: null });
  expect(body.fx.value).toBe(1.3961);
  expect(body.withholding["VFV.TO"]).toContain("withholding");
});

test("GETs never fetch", async () => {
  boot();
  const s = investing();
  recordCloses(db, "NOW", [{ date: "2026-11-04", close: 900, adjClose: null, source: "demo" }]);
  for (const path of [
    `/api/investing/${s.id}/health`,
    `/api/investing/${s.id}/research/NOW`,
    `/api/investing/${s.id}/research/XEQT.TO`,
    `/api/investing/${s.id}/ideas`,
    `/api/investing/${s.id}/screener`,
    `/api/investing/${s.id}/digests`,
    "/api/investing/budget",
    "/api/investing/tfsa?year=2026",
  ]) {
    const r = await get(path);
    expect(`${path} ${r.status}`).toBe(`${path} 200`);
  }
  expect(fetchCalls).toEqual([]);
});

test("research: notes, a thesis draft for Claude, and Nakul's own earnings date", async () => {
  boot();
  const s = investing();
  expect((await call("PUT", `/api/investing/${s.id}/research/NOW/notes`, { thesis: "Platform wins." })).status).toBe(200);
  const view = await (await get(`/api/investing/${s.id}/research/NOW`)).json();
  expect(view.notes.thesis).toBe("Platform wins.");
  expect(view.key).toBe("NOW");
  const xeqt = await (await get(`/api/investing/${s.id}/research/XEQT.TO`)).json();
  expect(xeqt.lookThrough.coverage).toBeGreaterThan(0.85);
  const d = await call("POST", `/api/investing/${s.id}/research/NOW/thesis-draft`);
  const { taskId } = await d.json();
  expect(listTasks(db).find((t) => t.id === taskId)).toMatchObject({ agent: "claude", purpose: "thesis_draft", subject: "NOW" });
  expect((await get(`/api/investing/${s.id}/research/NOW`).then((r) => r.json())).drafting).toBe(true);
  expect((await call("POST", `/api/investing/${s.id}/research/NOW/thesis-draft`)).status).toBe(400);
  expect((await call("POST", `/api/investing/${s.id}/research/ATZ.TO/earnings`, { date: "2026-12-10", hour: "bmo" })).status).toBe(200);
  const atz = await (await get(`/api/investing/${s.id}/research/ATZ.TO`)).json();
  expect(atz.earnings[0]).toMatchObject({ date: "2026-12-10", source: "you" });
  expect((await get(`/api/investing/${s.id}/research/not a symbol`)).status).toBe(400);
  expect(await (await get(`/api/investing/${s.id}/research/not a symbol`)).json()).toEqual({ error: "Type a symbol like AAPL or SHOP.TO." });
  expect((await get("/api/investing/spc_nope/health")).status).toBe(404);
});

test("a fund refresh by hand, then refused the same day", async () => {
  boot();
  const s = investing();
  db.query("DELETE FROM fund_files WHERE fund = 'XEQT.TO'").run();
  allowFetch = true;
  const first = await call("POST", `/api/investing/${s.id}/funds/XEQT.TO/refresh`);
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ asOf: "2026-11-04", source: "ishares-ca" });
  const second = await call("POST", `/api/investing/${s.id}/funds/XEQT.TO/refresh`);
  expect(second.status).toBe(422);
  expect(await second.json()).toEqual({ error: "Holdings for XEQT.TO were already refreshed today." });
});

test("budget lists all 11 sources and Alpha Vantage's reserve", async () => {
  boot();
  const b = await (await get("/api/investing/budget")).json();
  expect(b.sources).toHaveLength(11);
  expect(b.alphaVantage).toMatchObject({ reserve: 5, used: 0, plan: [], deferred: [] });
  expect(Array.isArray(b.jobs)).toBe(true);
});

test("ideas and the screener", async () => {
  boot();
  const s = investing();
  const ideas = await (await get(`/api/investing/${s.id}/ideas`)).json();
  expect(ideas.map((i: { key: string; stage: string }) => [i.key, i.stage])).toContainEqual(["NOW", "owned"]);
  expect((await call("PUT", `/api/investing/${s.id}/ideas/QBTS`, { stage: "researching", note: "Quantum" })).status).toBe(200);
  expect((await call("PUT", `/api/investing/${s.id}/ideas/QBTS`, { stage: "nope" })).status).toBe(400);
  const rows = await (await get(`/api/investing/${s.id}/screener`)).json();
  expect(rows.map((r: { key: string }) => r.key)).toContain("NOW");
});

test("TFSA room round-trip, with the over-contribution text", async () => {
  boot();
  expect((await call("PUT", "/api/investing/tfsa/room", { year: 2026, roomJan1: 1000 })).status).toBe(200);
  const e = await (await call("POST", "/api/investing/tfsa/entries", { date: "2026-02-01", kind: "contribution", amount: 1300 })).json();
  const t = await (await get("/api/investing/tfsa?year=2026")).json();
  expect(t.text).toBe("Over by CA$300.00: CRA charges 1% a month on the excess until it's withdrawn.");
  expect(t.entries).toHaveLength(1);
  expect((await call("DELETE", `/api/investing/tfsa/entries/${e.id}`)).status).toBe(200);
  expect((await (await get("/api/investing/tfsa?year=2026")).json()).remaining).toBe(1000);
  expect((await call("POST", "/api/investing/tfsa/entries", { date: "2026-02-01", kind: "contribution", amount: -1 })).status).toBe(400);
});

test("cross-site requests are refused on the new routes too", async () => {
  boot();
  const s = investing();
  const r = await fetch(`${base}/api/investing/${s.id}/health`, { headers: { origin: "https://evil.example" } });
  expect(r.status).toBe(403);
  const w = await fetch(`${base}/api/investing/tfsa/room`, { method: "PUT", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" });
  expect(w.status).toBe(403);
});

test("the markets view carries the portfolio's day and the VFV estimate", async () => {
  boot();
  const s = investing();
  const v = await (await get(`/api/markets/${s.id}`)).json();
  expect(v).toHaveProperty("portfolio");
  expect(v).toHaveProperty("estimates");
});

test("the EDGAR cross-check stays off until a contact email is saved, and can be turned off again", async () => {
  boot();
  expect((await (await get("/api/investing/budget")).json()).edgar).toMatchObject({ on: false, contact: null, note: "Off — add a contact email" });
  expect((await call("PUT", "/api/investing/edgar", { contact: "nope" })).status).toBe(400);
  expect((await call("PUT", "/api/investing/edgar", { contact: "nakul@example.com" })).status).toBe(200);
  expect((await (await get("/api/investing/budget")).json()).edgar).toMatchObject({ on: true, contact: "nakul@example.com", note: null });
  expect((await call("PUT", "/api/investing/edgar", { on: false })).status).toBe(200);
  expect((await (await get("/api/investing/budget")).json()).edgar.on).toBe(false);
  expect((await call("PUT", "/api/investing/edgar", { on: "yes" })).status).toBe(400);
});

test("setup creates the Investing space once", async () => {
  boot();
  const a = await (await call("POST", "/api/investing/setup")).json();
  expect(a).toMatchObject({ created: true, added: 13 });
  const b = await (await call("POST", "/api/investing/setup")).json();
  expect(b).toEqual({ spaceId: a.spaceId, created: false, added: 0 });
});
