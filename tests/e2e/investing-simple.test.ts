// Plan 10 end to end, offline: one in-process engine on Finnhub (with Tiingo) through a fetch stub that serves the
// recorded files by host and path, fails the test on any TradingView host, fake timers, and a market clock the test
// drives. The scenarios run in order and share the engine, from Wednesday's close to Saturday morning.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDb } from "../../src/engine/db";
import { getSpace } from "../../src/engine/spaces";
import { getTask, listTasks } from "../../src/engine/tasks";
import { isAdvanced } from "../../src/engine/markets/advanced";
import { createMarketsHooks } from "../../src/engine/markets/agent";
import { createAlert, evaluateQuotes, listAlerts } from "../../src/engine/markets/alerts";
import { createMarketData } from "../../src/engine/markets/data";
import { eodJob } from "../../src/engine/markets/eod";
import { newsJob } from "../../src/engine/markets/events";
import { createFeed } from "../../src/engine/markets/feed";
import { fundsJob } from "../../src/engine/markets/funds/refresh";
import { fxJob } from "../../src/engine/markets/fx";
import { addHolding } from "../../src/engine/markets/holdings";
import { createJobs } from "../../src/engine/markets/jobs";
import { createKeychain } from "../../src/engine/markets/keychain";
import { listItems, listLists } from "../../src/engine/markets/lists";
import { metaJob } from "../../src/engine/markets/meta";
import { digestJob } from "../../src/engine/markets/research";
import { seedDemoInvesting } from "../fixtures/markets/demo-tickers";
import { enqueueDueStrategies } from "../../src/engine/markets/strategies";
import { startServer } from "../../src/server/server";
import { fakeTimers } from "../engine/markets/fakes";
import { tempHome } from "../helpers";

const FIX = resolve(import.meta.dir, "../fixtures/markets");
const FAKE = resolve(import.meta.dir, "../fixtures/fake-security.ts");
// November 2026 is EST (UTC−5).
const et = (s: string) => Date.parse(`${s}-05:00`);
const ISSUERS = ["blackrock.com", "ssga.com", "roundhillinvestments.com", "invesco.com", "wikipedia.org", "sec.gov"];

let home: ReturnType<typeof tempHome>;
let keyDir: string;
let db: Database;
let server: ReturnType<typeof startServer>;
let base: string;
let spaceId: string;
let clock = et("2026-11-04T17:05:00");
const fetched: string[] = [];
const tradingView: string[] = [];
const ran: string[][] = [];
const timers = fakeTimers();
let feed: ReturnType<typeof createFeed>;
let data: ReturnType<typeof createMarketData>;
let kicks = 0;

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const file = (path: string) => new Response(readFileSync(join(FIX, path)));
const stub = (async (input: string | URL | Request) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  fetched.push(url.href);
  if (url.host.includes("tradingview")) {
    tradingView.push(url.href);
    throw new Error("TradingView is never fetched by the engine");
  }
  if (url.host === "www.bankofcanada.ca") return file(`investing/${url.searchParams.has("start_date") ? "boc-history.json" : "boc-recent.json"}`);
  if (url.host === "api.tiingo.com") return file("investing/tiingo-spy.json");
  if (url.host === "finnhub.io") {
    const symbol = url.searchParams.get("symbol") ?? "";
    switch (url.pathname) {
      case "/api/v1/quote":
        return json(symbol === "AMZN" ? { c: 250, pc: 245, t: Math.floor(clock / 1000) } : { c: 100, pc: 99, t: Math.floor(clock / 1000) });
      case "/api/v1/search":
        return url.searchParams.get("q") === "aritzia" ? file("simple/finnhub-search-aritzia.json") : json({ count: 0, result: [] });
      case "/api/v1/stock/profile2":
        return symbol === "NOW" ? file("investing/finnhub-profile2.json") : json({});
      case "/api/v1/stock/metric":
        return file("investing/finnhub-metric.json");
      case "/api/v1/calendar/earnings":
        return file("investing/finnhub-earnings.json");
      case "/api/v1/company-news":
        return json([]);
    }
  }
  throw new Error(`no fixture for ${url.href}`);
}) as unknown as typeof fetch;

const call = (method: string, path: string, body?: unknown) =>
  fetch(base + path, { method, headers: { origin: base, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const get = (path: string) => fetch(base + path);
const step = async (at: number): Promise<string[]> => {
  const before = ran.length;
  clock = at;
  timers.fireAll();
  await feed.idle();
  return ran.slice(before).flat();
};

beforeAll(async () => {
  home = tempHome();
  keyDir = mkdtempSync(join(tmpdir(), "atrium-keys-"));
  process.env.FAKE_SECURITY_STORE = join(keyDir, "store.json");
  db = openDb();
  const now = () => clock;
  const keychain = createKeychain(FAKE);
  await keychain.set("finnhub.token", "FHTEST12345");
  await keychain.set("tiingo.token", "TGTEST12345");
  data = createMarketData({ db, keychain, now, fetch: stub });
  await data.reload();
  const jobs = createJobs(
    db,
    [
      fxJob(db, { fetch: stub, now }),
      eodJob(db, { data, tiingo: () => data.tiingo?.() ?? null, now }),
      fundsJob(db, { fetch: stub, now }),
      metaJob(db, { data, now, fetch: stub, sleep: async () => {} }),
      newsJob(db, { data, now }),
      digestJob(db),
    ],
    now,
  );
  const recorded = { runDue: async (at: number) => void ran.push(await jobs.runDue(at)), status: jobs.status };
  feed = createFeed({ db, data, now, timers, jobs: recorded, onQuotes: (q) => evaluateQuotes(db, q, clock), strategyActive: () => false });
  server = startServer({ db, runner: { kick: () => void kicks++ }, setup: async () => { throw new Error("no"); }, port: 0, markets: { data, feed, keychain, kick: () => void kicks++, now, fetch: stub, jobs } });
  base = `http://127.0.0.1:${server.port}`;
  spaceId = seedDemoInvesting(db).spaceId;
  addHolding(db, spaceId, { account: "TFSA", symbol: "AMZN", exchange: "US", name: "Amazon", quantity: 10, bookValue: 1500, currency: "USD" });
});

afterAll(() => {
  feed?.stop();
  server?.stop(true);
  db.close();
  delete process.env.FAKE_SECURITY_STORE;
  rmSync(keyDir, { recursive: true, force: true });
  home.cleanup();
  expect(tradingView).toEqual([]);
});

test("1. an old single watchlist becomes Holdings", () => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-old-"));
  try {
    const path = join(dir, "atrium.db");
    const old = openDb(path);
    old.exec("DROP TABLE market_watchlist");
    old.exec("DROP TABLE market_lists");
    old.exec(`CREATE TABLE market_watchlist (space_id TEXT NOT NULL REFERENCES spaces(id), symbol TEXT NOT NULL, exchange TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '', added_at INTEGER NOT NULL, PRIMARY KEY (space_id, symbol, exchange))`);
    old.query("INSERT INTO spaces (id, name, kind, goal, color, private, status, created_at, updated_at) VALUES ('spc_inv', 'Investing', 'markets', '', '#fff', 1, 'active', 1, 1)").run();
    const keys = ["ATZ.TO", "NOW", "TSLA", "AMZN", "MARS", "DRAM", "SPY", "VFV.TO", "QQQ", "QBTS", "SOFI", "RKLB", "XEQT.TO"];
    keys.forEach((k, n) => {
      const [symbol, ex] = k.endsWith(".TO") ? [k.slice(0, -3), "TSX"] : [k, "US"];
      old.query("INSERT INTO market_watchlist VALUES ('spc_inv', ?, ?, '', ?)").run(symbol, ex, n + 1);
    });
    old.close();
    const first = openDb(path);
    const lists = listLists(first, "spc_inv");
    expect(lists.map((l) => l.name)).toEqual(["Holdings"]);
    expect(listItems(first, lists[0]!.id).map((i) => i.key)).toEqual(keys);
    first.close();
    const second = openDb(path);
    expect(listLists(second, "spc_inv").map((l) => l.id)).toEqual(lists.map((l) => l.id));
    expect(listItems(second, lists[0]!.id)).toHaveLength(13);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("2. Wednesday after the close with Advanced off: fx, eod and the digest run, and no thesis checks", async () => {
  expect(isAdvanced(db, spaceId)).toBe(false);
  await feed.start();
  await feed.idle();
  expect(ran.flat()).toEqual(expect.arrayContaining(["fx", "eod"]));
  // The digest waits for prices from the close.
  await feed.refreshNow();
  expect(await step(et("2026-11-04T17:20:00"))).toContain("digest");
  expect(listTasks(db, { spaceId }).filter((t) => t.purpose === "digest").map((t) => t.agent)).toEqual(["claude"]);
  expect(listTasks(db).filter((t) => t.purpose === "thesis_check")).toEqual([]);
  expect(fetched.filter((u) => ISSUERS.some((h) => u.includes(h)))).toEqual([]);
  // News waits for Advanced or a big-news alert; nothing asked Finnhub for it.
  expect(fetched.filter((u) => u.includes("/company-news"))).toEqual([]);
});

test("3. Advanced off keeps a strategy and an RSI alert but runs neither; turning it on brings them back", async () => {
  db.query(
    "INSERT INTO market_strategies (id, space_id, name, rules, symbols, cadence, max_position_value, max_trades_per_day, status, created_at, updated_at) VALUES ('stg_1', ?, 'Momentum', 'r', '[\"AMZN\"]', 'open', 1000, 3, 'active', 1, 1)",
  ).run(spaceId);
  const rsi = createAlert(db, { spaceId, key: "AMZN", rule: { kind: "rsi_above", level: 1, period: 14 } });
  await step(et("2026-11-05T10:01:00"));
  expect(enqueueDueStrategies(db, clock, () => {})).toBe(0);
  expect(listTasks(db).filter((t) => t.strategyId)).toEqual([]);
  expect(listAlerts(db, spaceId).find((a) => a.id === rsi.id)?.status).toBe("armed");
  const view = await (await get(`/api/markets/${spaceId}`)).json();
  expect(view.strategies.map((s: { id: string }) => s.id)).toEqual(["stg_1"]);
  expect(view.alerts.map((a: { id: string }) => a.id)).toContain(rsi.id);
  expect(await (await call("PUT", `/api/investing/${spaceId}/advanced`, { on: true })).json()).toEqual({ advanced: true });
  expect(enqueueDueStrategies(db, clock, () => {})).toBe(1);
  expect(await (await call("PUT", `/api/investing/${spaceId}/advanced`, { on: false })).json()).toEqual({ advanced: false });
});

test("4. search finds Aritzia on the TSX and it goes into Holdings", async () => {
  const r = await (await call("POST", "/api/investing/search", { q: "aritzia" })).json();
  expect(r.hits[0].key).toBe("ATZ.TO");
  const holdings = listLists(db, spaceId)[0]!;
  expect((await call("POST", `/api/investing/${spaceId}/lists/${holdings.id}/items`, { key: "ATZ.TO" })).status).toBe(200);
  const lists = await (await get(`/api/investing/${spaceId}/lists`)).json();
  expect(lists.lists[0].rows.map((x: { key: string }) => x.key)).toContain("ATZ.TO");
});

test("5. symbols map to TradingView and its page is served only by the chart listener, never fetched", async () => {
  const mars = await (await get(`/api/investing/${spaceId}/symbol/MARS`)).json();
  expect(mars).toMatchObject({ tv: "CBOE:MARS", chart: { ok: true } });
  expect((await (await get(`/api/investing/${spaceId}/symbol/AMZN`)).json()).tv).toBe("NASDAQ:AMZN");
  const ep = server.embedPort!;
  const page = await fetch(`http://127.0.0.1:${ep}/embed/${server.embedToken}/tradingview?symbol=NASDAQ%3AAMZN&parent=${encodeURIComponent(base)}`, { headers: { host: `localhost:${ep}` } });
  expect(page.status).toBe(200);
  expect(page.headers.get("content-security-policy")).toContain(`frame-ancestors ${base}`);
  expect(tradingView).toEqual([]);
});

test("6. Ask Claude about AMZN queues a Claude task whose answer is kept and listed", async () => {
  const r = await (await call("POST", `/api/investing/${spaceId}/symbol/AMZN/ask`, { question: "Why up today?" })).json();
  const task = getTask(db, r.taskId)!;
  expect(task).toMatchObject({ agent: "claude", purpose: "ask", subject: "AMZN", detail: "Why up today?" });
  const hooks = createMarketsHooks(db, { data, now: () => clock });
  const context = await hooks.context(task, getSpace(db, spaceId)!, "claude");
  expect(context).toContain("The user asks: Why up today?");
  db.query("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id);
  expect(await hooks.settle(task, getSpace(db, spaceId)!, "claude", "AWS carried the quarter.")).toMatchObject({ done: true, activity: "Answer saved" });
  const view = await (await get(`/api/investing/${spaceId}/symbol/AMZN`)).json();
  expect(view.asks[0].body).toBe("AWS carried the quarter.\n\nAnalysis, not advice.");
  expect(view.asks[0].question).toBe("Why up today?");
});

test("7. the simple views make no network calls", async () => {
  const before = fetched.length;
  for (const path of ["portfolio", "lists", "earnings", "glance"]) expect((await get(`/api/investing/${spaceId}/${path}`)).status).toBe(200);
  expect(fetched.slice(before)).toEqual([]);
});

test("8. Saturday: two quiet hours make no calls, and the weekly funds job runs as a no-op with Advanced off", async () => {
  // Friday's after-close jobs run first; then every job is done until Saturday's weekly ones.
  expect(await step(et("2026-11-06T17:30:00"))).toEqual(expect.arrayContaining(["eod", "fx"]));
  const quiet = fetched.length;
  clock = et("2026-11-07T03:00:00");
  for (let i = 0; i < 8; i++) await step(clock + 15 * 60_000);
  expect(fetched.slice(quiet)).toEqual([]);
  const before = fetched.length;
  expect(await step(et("2026-11-07T10:05:00"))).toEqual(expect.arrayContaining(["funds", "meta"]));
  expect(fetched.slice(before).filter((u) => ISSUERS.some((h) => u.includes(h)))).toEqual([]);
});
