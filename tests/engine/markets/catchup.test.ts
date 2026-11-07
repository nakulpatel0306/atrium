import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../../src/engine/db";
import { createSpace } from "../../../src/engine/spaces";
import { dailyBudget } from "../../../src/engine/markets/budget";
import { createCatchUp, earningsStale, tsxClosesMissing } from "../../../src/engine/markets/catchup";
import { recordCloses } from "../../../src/engine/markets/closes";
import type { MarketData } from "../../../src/engine/markets/data";
import { eodJob } from "../../../src/engine/markets/eod";
import { instrumentKey, type Instrument } from "../../../src/engine/markets/instrument";
import { createJobs } from "../../../src/engine/markets/jobs";
import { getMeta, metaJob, metaStale } from "../../../src/engine/markets/meta";
import { ProviderError } from "../../../src/engine/markets/providers/types";
import { earningsView } from "../../../src/engine/markets/views";
import { tempHome } from "../../helpers";

let home: ReturnType<typeof tempHome>;
let db: Database;
let spaceId: string;
beforeEach(() => {
  home = tempHome();
  db = openDb();
  spaceId = createSpace(db, { name: "Investing", kind: "markets", goal: "g" }).id;
  for (const s of ["RKLB", "QBTS", "META", "SPY"]) {
    db.query("INSERT INTO market_holdings (id, space_id, account, symbol, exchange, quantity, currency, source, updated_at) VALUES (?, ?, 'TFSA', ?, 'US', 1, 'USD', 'manual', 1)").run(`h_${s}`, spaceId, s);
  }
});
afterEach(() => {
  db.close();
  home.cleanup();
});

const START = Date.parse("2026-11-06T13:00:00Z"); // Fri 8:00 AM ET: the engine starts

// A fake Finnhub that records every call; it has no key until `keyed` is set.
function rig() {
  const calls: string[] = [];
  const state = { keyed: false };
  const research = {
    async earnings(list: Instrument[], from: string, to: string) {
      calls.push(`earnings ${list.map(instrumentKey).join(",")}`);
      const cal: Record<string, string> = { RKLB: "2026-11-09", QBTS: "2026-11-10" };
      return list.flatMap((i) => (cal[i.symbol] && cal[i.symbol]! >= from && cal[i.symbol]! <= to ? [{ key: i.symbol, date: cal[i.symbol]!, hour: null, epsEstimate: null }] : []));
    },
    async profile(i: Instrument) {
      calls.push(`profile ${i.symbol}`);
      return { name: i.symbol === "META" ? "Meta Platforms Inc" : `${i.symbol} Inc`, country: "US", currency: "USD", industry: "Media", exchange: "NASDAQ NMS - GLOBAL MARKET" };
    },
    async metric(i: Instrument) {
      calls.push(`metric ${i.symbol}`);
      return { pe: 25, high52: 800, low52: 450, divYield: 0.3, marketCap: 1_500_000 };
    },
  };
  const data = {
    quotes: async () => ({ quotes: [], missing: [] }),
    news: async () => [],
    research: () => (state.keyed ? research : null),
    // No Alpha Vantage key: the XEQT benchmark's close is quietly off, not missing.
    status: async () => ({ keys: { alphavantage: false } }),
    prepare: async () => {},
  } as unknown as MarketData;
  let clock = START;
  const now = () => clock;
  const jobs = createJobs(db, [eodJob(db, { data, tiingo: () => null, now }), metaJob(db, { data, now })], now);
  return { calls, state, jobs, catchUp: createCatchUp(db, { jobs, now }), at: (t: number) => (clock = t) };
}

test("on start without a key nothing is fetched; once the key is added, earnings and metadata catch up", async () => {
  const r = rig();
  expect(earningsStale(db, START)).toBe(true);
  expect(metaStale(db, START)).toBe(true);
  await r.catchUp.run(true);
  expect(r.calls).toEqual([]);
  expect(r.jobs.status().find((j) => j.name === "meta")!.lastError).toContain("add your Finnhub key");

  r.state.keyed = true;
  r.at(START + 5 * 60_000);
  await r.catchUp.run(true);
  expect(r.calls).toContain("earnings RKLB,QBTS,META");
  for (const s of ["RKLB", "QBTS", "META"]) expect(r.calls).toContain(`profile ${s}`);
  expect(r.calls).not.toContain("profile SPY");
  expect(earningsView(db, spaceId, START).rows.map((x) => [x.key, x.date])).toEqual([
    ["RKLB", "2026-11-09"],
    ["QBTS", "2026-11-10"],
  ]);
  expect(getMeta(db, ["META"]).get("META")).toMatchObject({ name: "Meta Platforms Inc", kind: "stock", pe: 25 });
  expect(r.jobs.status().map((j) => [j.name, j.lastError])).toEqual([["eod", null], ["meta", null]]);
});

test("with everything fresh, catch-up makes no calls; between forced runs it checks at most hourly", async () => {
  const r = rig();
  r.state.keyed = true;
  await r.catchUp.run(true);
  const n = r.calls.length;
  r.at(START + 10 * 60_000);
  await r.catchUp.run(true);
  expect(r.calls).toHaveLength(n);
  // A new holding makes earnings stale, but an unforced check within the hour waits.
  db.query("INSERT INTO market_holdings (id, space_id, account, symbol, exchange, quantity, currency, source, updated_at) VALUES ('h_SOFI', ?, 'TFSA', 'SOFI', 'US', 1, 'USD', 'manual', 2)").run(spaceId);
  expect(earningsStale(db, START + 10 * 60_000)).toBe(true);
  await r.catchUp.run();
  expect(r.calls).toHaveLength(n);
  r.at(START + 75 * 60_000);
  await r.catchUp.run();
  // Only the new holding is due; the others were checked an hour ago.
  expect(r.calls).toContain("earnings SOFI");
  expect(r.calls).toContain("profile SOFI");
});

test("two catch-ups at once share one run", async () => {
  const r = rig();
  r.state.keyed = true;
  await Promise.all([r.catchUp.run(true), r.catchUp.run(true)]);
  expect(r.calls.filter((c) => c.startsWith("earnings"))).toHaveLength(1);
});

// Tonight on the old code: the 16:30 run kept the US closes, but Alpha Vantage's per-second notice was read as the
// daily limit after a few calls, so no TSX closes for Nov 6, and the job still recorded success.
function tsxRig(opts: { daily?: boolean } = {}) {
  for (const s of ["ATZ", "VFV", "XEQT"]) {
    db.query("INSERT INTO market_holdings (id, space_id, account, symbol, exchange, quantity, currency, source, updated_at) VALUES (?, ?, 'TFSA', ?, 'TSX', 1, 'CAD', 'manual', 1)").run(`h_${s}`, spaceId, s);
  }
  const asked: string[][] = [];
  let clock = Date.parse("2026-11-07T01:30:00Z"); // Fri Nov 6, 8:30 PM ET, the new engine starts
  const budget = () => dailyBudget(db, "alphavantage", 25, () => clock);
  // The old run spent 3 calls, and its classifier set no exhaustion.
  for (let n = 0; n < 3; n++) budget().spend();
  if (opts.daily) budget().exhaust();
  const data = {
    quotes: async (list: Instrument[]) => {
      asked.push(list.map(instrumentKey));
      for (const i of list) if (i.exchange === "TSX") budget().spend(), recordCloses(db, instrumentKey(i), [{ date: "2026-11-06", close: 40, adjClose: null, source: "alphavantage" }]);
      return { quotes: [], missing: [] };
    },
    news: async () => [],
    research: () => null,
    status: async () => ({ keys: { alphavantage: true } }),
    prepare: async () => {},
  } as unknown as MarketData;
  const now = () => clock;
  db.query("INSERT INTO settings (key, value) VALUES ('markets.job.eod', ?)").run(
    JSON.stringify({ ranFor: Date.parse("2026-11-06T21:30:00Z"), lastRunAt: Date.parse("2026-11-06T21:30:00Z"), lastError: null, attempts: 0, lastAttemptAt: null }),
  );
  const jobs = createJobs(db, [eodJob(db, { data, tiingo: () => null, now })], now);
  return { asked, jobs, catchUp: createCatchUp(db, { jobs, now }), at: (t: number) => (clock = t) };
}

test("missing TSX closes from a misread throttle are fetched again once, on start, within the budget", async () => {
  const r = tsxRig();
  expect(tsxClosesMissing(db, Date.parse("2026-11-07T01:30:00Z"))).toEqual({ date: "2026-11-06", keys: ["ATZ.TO", "VFV.TO", "XEQT.TO"] });
  await r.catchUp.run(true);
  expect(r.asked.filter((l) => l.some((k) => k.endsWith(".TO")))).toEqual([["ATZ.TO", "VFV.TO", "XEQT.TO"]]);
  expect(tsxClosesMissing(db, Date.parse("2026-11-07T01:35:00Z"))).toBeNull();
});

test("the retry happens once per session, and never after a real daily-limit notice", async () => {
  const once = tsxRig();
  await once.catchUp.run(true);
  db.query("DELETE FROM market_closes").run();
  once.at(Date.parse("2026-11-07T03:00:00Z"));
  await once.catchUp.run(true);
  expect(once.asked.filter((l) => l.some((k) => k.endsWith(".TO")))).toHaveLength(1);
});

test("during TSX hours the retry waits, since Yahoo prices the day and keeps no closes", async () => {
  const r = tsxRig();
  r.at(Date.parse("2026-11-09T15:00:00Z")); // Mon 10:00 AM ET, Friday's closes still missing
  await r.catchUp.run(true);
  expect(r.asked.filter((l) => l.some((k) => k.endsWith(".TO")))).toEqual([]);
  r.at(Date.parse("2026-11-09T21:30:00Z"));
  await r.catchUp.run(true);
  expect(r.asked.filter((l) => l.some((k) => k.endsWith(".TO")))).toHaveLength(1);
});

test("a real daily limit (the budget is used up) waits for tomorrow", async () => {
  const r = tsxRig({ daily: true });
  await r.catchUp.run(true);
  expect(r.asked.filter((l) => l.some((k) => k.endsWith(".TO")))).toEqual([]);
});

test("a rate limit partway through earnings keeps the dates it got, and catch-up asks only for the rest", async () => {
  const asked: string[] = [];
  let limited = true;
  const research = {
    async earnings(list: Instrument[]) {
      asked.push(list.map(instrumentKey).join(","));
      const rows: { key: string; date: string; hour: string | null; epsEstimate: null }[] = [];
      const done: string[] = [];
      for (const i of list) {
        if (limited && i.symbol === "QBTS") {
          const e = new ProviderError("rate_limited", "Finnhub says too many requests; Atrium will try again in a minute.");
          e.partial = { done, rows };
          throw e;
        }
        if (i.symbol === "RKLB") rows.push({ key: "RKLB", date: "2026-11-09", hour: "amc", epsEstimate: null });
        if (i.symbol === "QBTS") rows.push({ key: "QBTS", date: "2026-11-10", hour: null, epsEstimate: null });
        done.push(instrumentKey(i));
      }
      return rows;
    },
  };
  const data = { quotes: async () => ({ quotes: [], missing: [] }), news: async () => [], research: () => research, status: async () => ({ keys: { alphavantage: false } }), prepare: async () => {} } as unknown as MarketData;
  let clock = START;
  const jobs = createJobs(db, [eodJob(db, { data, tiingo: () => null, now: () => clock })], () => clock);
  const catchUp = createCatchUp(db, { jobs, now: () => clock });
  await catchUp.run(true);
  expect(earningsView(db, spaceId, START).rows.map((x) => x.key)).toEqual(["RKLB"]);
  expect(jobs.steps("eod").earnings?.status).toBe("waiting");
  limited = false;
  clock += 61 * 60_000;
  await catchUp.run();
  expect(asked).toEqual(["RKLB,QBTS,META", "QBTS,META"]);
  expect(earningsView(db, spaceId, START).rows.map((x) => x.key)).toEqual(["RKLB", "QBTS"]);
  expect(jobs.steps("eod").earnings).toBeUndefined();
});

test("before today's 16:30 run, a retry of yesterday's TSX closes leaves that run its share of Alpha Vantage", async () => {
  const r = tsxRig();
  // Mon 1:00 AM ET (Friday's closes missing): 22 left, 5 reserved, 3 kept for tonight's ATZ, VFV and XEQT.
  for (let n = 0; n < 12; n++) dailyBudget(db, "alphavantage", 25, () => Date.parse("2026-11-09T06:00:00Z")).spend();
  r.at(Date.parse("2026-11-09T06:00:00Z"));
  await r.catchUp.run(true);
  // 25 − 12 used − 5 reserve − 3 for tonight = 5 available, enough for all three.
  expect(r.asked.filter((l) => l.some((k) => k.endsWith(".TO")))).toEqual([["ATZ.TO", "VFV.TO", "XEQT.TO"]]);
});

test("with only tonight's share left, the retry waits and says why", async () => {
  const r = tsxRig();
  const at = Date.parse("2026-11-09T06:00:00Z");
  for (let n = 0; n < 17; n++) dailyBudget(db, "alphavantage", 25, () => at).spend();
  r.at(at);
  await r.catchUp.run(true);
  expect(r.asked.filter((l) => l.some((k) => k.endsWith(".TO")))).toEqual([]);
  expect(r.jobs.steps("eod")["ca-closes"]).toEqual({
    status: "waiting",
    reason: "Canadian closes for 2026-11-06 wait for ATZ.TO, VFV.TO, XEQT.TO: Alpha Vantage's budget is kept for tonight's closes.",
  });
});

test("one symbol whose earnings call always errors doesn't block the others, runs once per catch-up, and backs off", async () => {
  for (const s of ["SOFI", "TSLA"]) {
    db.query("INSERT INTO market_holdings (id, space_id, account, symbol, exchange, quantity, currency, source, updated_at) VALUES (?, ?, 'TFSA', ?, 'US', 1, 'USD', 'manual', 2)").run(`h_${s}`, spaceId, s);
  }
  const asked: string[] = [];
  const cal: Record<string, string> = { RKLB: "2026-11-09", SOFI: "2026-11-24", TSLA: "2026-11-18" };
  const research = {
    async earnings(list: Instrument[]) {
      asked.push(list.map(instrumentKey).join(","));
      const rows = list.filter((i) => cal[i.symbol]).map((i) => ({ key: i.symbol, date: cal[i.symbol]!, hour: null, epsEstimate: null }));
      const done = list.filter((i) => i.symbol !== "QBTS").map(instrumentKey);
      if (!list.some((i) => i.symbol === "QBTS")) return rows;
      const e = new ProviderError("unavailable", "Finnhub returned an error (HTTP 500); Atrium will try again.");
      e.partial = { done, rows, failed: [{ key: "QBTS", reason: e.message }] };
      throw e;
    },
  };
  const data = { quotes: async () => ({ quotes: [], missing: [] }), news: async () => [], research: () => research, status: async () => ({ keys: { alphavantage: false } }), prepare: async () => {} } as unknown as MarketData;
  let clock = START;
  const jobs = createJobs(db, [eodJob(db, { data, tiingo: () => null, now: () => clock })], () => clock);
  const catchUp = createCatchUp(db, { jobs, now: () => clock });
  await catchUp.run(true);
  // QBTS sits first in the list and still doesn't stop RKLB, SOFI or TSLA.
  expect(asked).toEqual(["RKLB,QBTS,META,SOFI,TSLA"]);
  expect(earningsView(db, spaceId, START).rows.map((x) => x.key).sort()).toEqual(["RKLB", "SOFI", "TSLA"]);
  expect(jobs.steps("eod").earnings).toMatchObject({ status: "waiting" });
  // Hourly catch-ups while QBTS is backed off ask nothing.
  for (let h = 1; h <= 5; h++) {
    clock = START + h * 61 * 60_000;
    await catchUp.run();
  }
  expect(asked).toHaveLength(1);
  // Once its six hours are up, QBTS alone is asked again, once in that catch-up.
  clock = START + 7 * 3_600_000;
  await catchUp.run();
  expect(asked).toEqual(["RKLB,QBTS,META,SOFI,TSLA", "QBTS"]);
});

test("a metric that keeps failing backs off its symbol and doesn't bring the meta job back every hour", async () => {
  const asked: string[] = [];
  const research = {
    async profile(i: Instrument) {
      asked.push(`profile ${i.symbol}`);
      return { name: `${i.symbol} Inc`, country: "US", currency: "USD", industry: null, exchange: "NASDAQ" };
    },
    async metric(i: Instrument) {
      asked.push(`metric ${i.symbol}`);
      if (i.symbol === "QBTS") throw new ProviderError("unavailable", "Finnhub returned an error (HTTP 500); Atrium will try again.");
      return { pe: 1, high52: 2, low52: 1, divYield: null, marketCap: 10 };
    },
    async earnings() {
      return [];
    },
  };
  const data = { quotes: async () => ({ quotes: [], missing: [] }), news: async () => [], research: () => research, status: async () => ({ keys: { alphavantage: false } }), prepare: async () => {} } as unknown as MarketData;
  let clock = START;
  const jobs = createJobs(db, [eodJob(db, { data, tiingo: () => null, now: () => clock }), metaJob(db, { data, now: () => clock })], () => clock);
  const catchUp = createCatchUp(db, { jobs, now: () => clock });
  await catchUp.run(true);
  expect(asked.filter((a) => a.startsWith("metric"))).toEqual(["metric RKLB", "metric QBTS", "metric META"]);
  expect(getMeta(db, ["RKLB", "META"]).get("META")!.pe).toBe(1);
  expect(jobs.steps("meta").finnhub).toEqual({ status: "waiting", reason: "Key stats for QBTS failed: Finnhub returned an error (HTTP 500); Atrium will try again." });
  const n = asked.length;
  for (let h = 1; h <= 5; h++) {
    clock = START + h * 61 * 60_000;
    expect(await catchUp.run()).toEqual([]);
  }
  expect(asked).toHaveLength(n);
  clock = START + 7 * 3_600_000;
  await catchUp.run();
  expect(asked.slice(n)).toEqual(["metric QBTS"]);
});
