// Plan 7 end to end, offline: one in-process engine on the demo provider, a fetch stub that serves the recorded
// issuer, Bank of Canada and EDGAR files and records anything else, fake timers, and a market clock the test drives.
// The scenarios run in order and share the engine, like a day (and a weekend) of Atrium running.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { listPending } from "../../src/engine/approvals";
import { briefing } from "../../src/engine/briefing";
import { openDb } from "../../src/engine/db";
import { setSetting } from "../../src/engine/settings";
import { listTasks } from "../../src/engine/tasks";
import { getSpace } from "../../src/engine/spaces";
import { createMarketsHooks } from "../../src/engine/markets/agent";
import { createAlert, evaluateEvents, evaluateQuotes } from "../../src/engine/markets/alerts";
import { createMarketData } from "../../src/engine/markets/data";
import { eodJob } from "../../src/engine/markets/eod";
import { newsJob } from "../../src/engine/markets/events";
import { createFeed } from "../../src/engine/markets/feed";
import { fundsJob } from "../../src/engine/markets/funds/refresh";
import { loadFundFile } from "../../src/engine/markets/funds/store";
import { fxJob } from "../../src/engine/markets/fx";
import { addHolding, listHoldings } from "../../src/engine/markets/holdings";
import { listIdeas } from "../../src/engine/markets/ideas";
import { createJobs } from "../../src/engine/markets/jobs";
import { createKeychain } from "../../src/engine/markets/keychain";
import { metaJob } from "../../src/engine/markets/meta";
import { lookThroughFor } from "../../src/engine/markets/portfolio";
import { demoProvider } from "../../src/engine/markets/providers/demo";
import { digestJob, latestWriteups } from "../../src/engine/markets/research";
import { seedInvesting } from "../../src/engine/markets/seed";
import { listWatchlist } from "../../src/engine/markets/watchlist";
import { briefingMarketsLine } from "../../src/dashboard/markets";
import { startServer } from "../../src/server/server";
import { fakeTimers } from "../engine/markets/fakes";
import { tempHome } from "../helpers";

const FIX = resolve(import.meta.dir, "../fixtures/markets");
const INV = join(FIX, "investing");
const FAKE = resolve(import.meta.dir, "../fixtures/fake-security.ts");
// November 2026 is EST (UTC−5).
const et = (s: string) => Date.parse(`${s}-05:00`);

let home: ReturnType<typeof tempHome>;
let keyDir: string;
let db: Database;
let server: ReturnType<typeof startServer>;
let base: string;
let spaceId: string;
let clock = et("2026-11-04T17:05:00");
const fetched: string[] = [];
const unexpected: string[] = [];
const ran: string[][] = [];
const timers = fakeTimers();
let feed: ReturnType<typeof createFeed>;
let data: ReturnType<typeof createMarketData>;

const file = (name: string) => new Response(readFileSync(join(INV, name)));
const stub = (async (input: string | URL | Request) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  fetched.push(url.href);
  switch (url.host) {
    case "www.bankofcanada.ca":
      return file(url.searchParams.has("start_date") ? "boc-history.json" : "boc-recent.json");
    case "www.blackrock.com":
      return file("ishares-xeqt.csv");
    case "www.ssga.com":
      return file("ssga-spy.xlsx");
    case "www.roundhillinvestments.com":
      return url.pathname.endsWith("_11042026.csv") ? file("roundhill-holdings.csv") : new Response("<!doctype html>", { headers: { "content-type": "text/html" } });
    case "www.invesco.com":
      return new Response("Not Acceptable", { status: 406 });
    case "en.wikipedia.org":
      return file("wikipedia-nasdaq100.json");
    case "www.sec.gov":
      return file("edgar-tickers.json");
    case "data.sec.gov":
      return file("edgar-facts-now.json");
  }
  unexpected.push(url.href);
  throw new Error(`no fixture for ${url.href}`);
}) as unknown as typeof fetch;

const call = (method: string, path: string, body?: unknown) =>
  fetch(base + path, { method, headers: { origin: base, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const step = async (at: number) => {
  clock = at;
  timers.fireAll();
  await feed.idle();
};

beforeAll(async () => {
  home = tempHome();
  keyDir = mkdtempSync(join(tmpdir(), "atrium-keys-"));
  process.env.FAKE_SECURITY_STORE = join(keyDir, "store.json");
  db = openDb();
  setSetting(db, "markets.provider", "demo");
  const now = () => clock;
  const keychain = createKeychain(FAKE);
  data = createMarketData({ db, keychain, now, fetch: stub, providers: { demo: demoProvider({ now }) } });
  const jobs = createJobs(
    db,
    [
      fxJob(db, { fetch: stub, now }),
      eodJob(db, { data, tiingo: () => null, now }),
      fundsJob(db, { fetch: stub, now }),
      metaJob(db, { data, now, fetch: stub, sleep: async () => {} }),
      newsJob(db, { data, now }),
      digestJob(db),
    ],
    now,
  );
  const recorded = { runDue: async (at: number) => void ran.push(await jobs.runDue(at)), status: jobs.status };
  feed = createFeed({ db, data, now, timers, jobs: recorded, onQuotes: (q) => evaluateQuotes(db, q, clock), strategyActive: () => false });
  server = startServer({ db, runner: { kick: () => {} }, setup: async () => { throw new Error("no"); }, port: 0, markets: { data, feed, keychain, kick: () => {}, now, fetch: stub, jobs } });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  feed?.stop();
  server?.stop(true);
  db.close();
  delete process.env.FAKE_SECURITY_STORE;
  rmSync(keyDir, { recursive: true, force: true });
  home.cleanup();
});

test("1. the 13 tickers, then a Wealthsimple import with CAD book values and owned ideas", async () => {
  spaceId = seedInvesting(db).spaceId;
  expect(listWatchlist(db, spaceId)).toHaveLength(13);
  const csv = readFileSync(join(FIX, "ws-holdings.csv"), "utf8");
  expect((await call("POST", `/api/markets/${spaceId}/import`, { csv })).status).toBe(200);
  addHolding(db, spaceId, { account: "TFSA", symbol: "SPY", exchange: "US", name: "SPY", quantity: 4, bookValue: 2000, currency: "USD" });
  const h = listHoldings(db, spaceId);
  expect(h.find((x) => x.key === "XEQT.TO")!.bookValueCad).toBe(1500);
  expect(h.find((x) => x.key === "KO")!.bookValueCad).toBe(1600);
  const owned = listIdeas(db, spaceId).filter((i) => i.stage === "owned").map((i) => i.key).sort();
  expect(owned).toEqual(["AAPL.NE", "KO", "SHOP.TO", "SPY", "XEQT.TO"]);
});

test("2. Wednesday after the close: fx, eod and digest run once; a later step runs nothing", async () => {
  await feed.start();
  await feed.idle();
  expect(ran.at(-1)).toEqual(expect.arrayContaining(["fx", "eod", "digest"]));
  expect(db.query("SELECT rate FROM fx_rates WHERE date = '2026-11-04'").get()).toEqual({ rate: 1.3961 });
  const digest = listTasks(db, { spaceId }).filter((t) => t.purpose === "digest");
  expect(digest.map((t) => t.agent)).toEqual(["claude"]);
  await step(et("2026-11-04T17:10:00"));
  expect(ran.at(-1)).toEqual([]);
  expect(fetched.every((u) => !u.includes("tiingo") && !u.includes("finnhub") && !u.includes("alphavantage"))).toBe(true);
});

test("3. Saturday morning: funds and meta run; look-through, swaps and the QQQ estimate", async () => {
  await step(et("2026-11-07T10:05:00"));
  expect(ran.at(-1)).toEqual(expect.arrayContaining(["funds", "meta"]));
  expect(lookThroughFor(db, "XEQT.TO")!.coverage).toBeGreaterThanOrEqual(0.9);
  // Watched, so fetched too: DRAM's swaps resolve to their companies.
  const dram = loadFundFile(db, "DRAM")!;
  expect(dram.lines.some((l) => l.via === "swap" && l.ticker === "MU")).toBe(true);
  expect(loadFundFile(db, "QQQ")!.source).toBe("ndx-estimate");
});

test("4. health is read from the DB: Bank of Canada CAD totals and a company held through two funds", async () => {
  await feed.refreshNow();
  const r = await fetch(`${base}/api/investing/${spaceId}/health`);
  expect(r.status).toBe(200);
  const { health } = await r.json();
  expect(health.totalCad.source).toContain("Bank of Canada");
  expect(health.byCompany.some((c: { via: unknown[] }) => c.via.length >= 2)).toBe(true);
});

test("5. an earnings alert on the demo's first symbol lands in Needs you as an earnings item", async () => {
  // The end-of-day job asks the demo calendar for US stocks in tracked order; KO, held first, reports 3 trading days
  // after that run (Saturday's catch-up run for Friday's slot: Wednesday Nov 11).
  expect(db.query("SELECT key, date, source FROM market_earnings").all()).toEqual([{ key: "KO", date: "2026-11-11", source: "finnhub" }]);
  createAlert(db, { spaceId, key: "KO", rule: { kind: "earnings_within", days: 5 } });
  expect(evaluateEvents(db, clock)).toBe(1);
  expect(evaluateEvents(db, clock)).toBe(0);
  expect(listPending(db).filter((a) => a.kind === "alert").map((a) => a.topic)).toEqual(["earnings"]);
  const s = await (await fetch(`${base}/api/summary`)).json();
  expect(s.alerts.earnings).toBe(1);
});

test("6. Sunday night with every job done: two hours of the feed's timer make no requests", async () => {
  const before = fetched.length;
  clock = et("2026-11-08T03:00:00");
  for (let i = 0; i < 8; i++) await step(clock + 15 * 60_000);
  expect(fetched.length).toBe(before);
  expect(ran.slice(-8).every((r) => r.length === 0)).toBe(true);
  expect(timers.pending.size).toBe(1);
});

test("7. a settled digest is stored with its label, and Home renders the investing line", async () => {
  const task = listTasks(db, { spaceId }).find((t) => t.purpose === "digest")!;
  const hooks = createMarketsHooks(db, { data, now: () => clock });
  const r = await hooks.settle(task, getSpace(db, spaceId)!, "claude", "SPY and XEQT drifted up; KO reports Monday.");
  expect(r.done).toBe(true);
  expect(latestWriteups(db, spaceId, { kind: "digest" })[0]!.body.endsWith("Analysis, not advice.")).toBe(true);
  const line = briefingMarketsLine(briefing(db, clock).markets!);
  expect(line).toStartWith("Portfolio ");
  expect(unexpected).toEqual([]);
});
