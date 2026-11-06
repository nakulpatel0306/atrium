import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../../src/engine/db";
import { createSpace } from "../../../src/engine/spaces";
import { dailyBudget, hourlyBudget } from "../../../src/engine/markets/budget";
import { closeOn } from "../../../src/engine/markets/closes";
import type { MarketData } from "../../../src/engine/markets/data";
import { eodJob } from "../../../src/engine/markets/eod";
import { instrumentKey, type Instrument } from "../../../src/engine/markets/instrument";
import { tiingoProvider, tiingoSymbols } from "../../../src/engine/markets/providers/tiingo";
import { getSetting } from "../../../src/engine/settings";
import { setAdvanced } from "../../../src/engine/markets/advanced";
import { addToWatchlist } from "../../../src/engine/markets/watchlist";
import type { Exchange } from "../../../src/engine/markets/instrument";
import { tempHome } from "../../helpers";
import { fixture, jsonResponse, stubFetch } from "./fakes";

let home: ReturnType<typeof tempHome>;
let db: Database;
let spaceId: string;
beforeEach(() => {
  home = tempHome();
  db = openDb();
  spaceId = createSpace(db, { name: "Investing", kind: "markets", goal: "g" }).id;
  // Plan 7 behaviour under test is Advanced-only; the gates themselves are tested with it off.
  setAdvanced(db, spaceId, true);
});
afterEach(() => {
  db.close();
  home.cleanup();
});

const hold = (symbol: string, exchange: string) =>
  db
    .query("INSERT INTO market_holdings (id, space_id, account, symbol, exchange, quantity, currency, source, updated_at) VALUES (?, ?, 'TFSA', ?, ?, 1, ?, 'manual', 1)")
    .run(`h_${symbol}`, spaceId, symbol, exchange, exchange === "US" ? "USD" : "CAD");
const watch = (symbol: string, exchange: string) =>
  addToWatchlist(db, spaceId, { symbol: symbol, exchange: exchange as Exchange });

function rig(clock: { now: number }) {
  const s = stubFetch(() => jsonResponse(fixture("investing/tiingo-spy.json")));
  const tsxCalls: string[][] = [];
  const data = {
    quotes: async (list: Instrument[]) => {
      tsxCalls.push(list.map(instrumentKey));
      return { quotes: [], missing: [] };
    },
    news: async () => [],
    prepare: async () => {},
  } as unknown as MarketData;
  const now = () => clock.now;
  const tiingo = () =>
    tiingoProvider("TGTEST12345", { fetch: s.fetch, now, budget: { day: dailyBudget(db, "tiingo", 950, now), hour: hourlyBudget(db, "tiingo", 48, now) }, symbols: tiingoSymbols(db, now) });
  return { s, tsxCalls, job: eodJob(db, { data, tiingo, now }) };
}

test("US closes backfill 400 days once, then continue from the last stored day", async () => {
  hold("NOW", "US");
  watch("SPY", "US");
  const clock = { now: Date.parse("2026-11-04T21:35:00Z") };
  const r = rig(clock);
  expect(r.job.name).toBe("eod");
  expect(r.job.slot).toEqual({ at: "16:30", days: "weekdays" });
  await r.job.run(clock.now);
  expect(r.s.calls.map((c) => c.url.pathname)).toEqual(["/tiingo/daily/NOW/prices", "/tiingo/daily/SPY/prices"]);
  for (const c of r.s.calls) expect(c.url.searchParams.get("startDate")).toBe("2025-09-30");
  expect(closeOn(db, "SPY", "2026-11-04")).toMatchObject({ close: 594.6, source: "tiingo" });
  expect(closeOn(db, "SPY", "2026-11-04")!.adjClose).not.toBeNull();
  expect(db.query("SELECT key, ex_date, amount, source FROM market_dividends WHERE key = 'SPY'").all()).toEqual([
    { key: "SPY", ex_date: "2026-10-27", amount: 1.83, source: "tiingo" },
  ]);
  clock.now += 86_400_000;
  await r.job.run(clock.now);
  for (const c of r.s.calls.slice(2)) expect(c.url.searchParams.get("startDate")).toBe("2026-11-05");
});

test("TSX closes follow the Alpha Vantage plan, and the rest wait", async () => {
  hold("ATZ", "TSX");
  watch("VFV", "TSX");
  const clock = { now: Date.parse("2026-11-04T21:35:00Z") };
  db.query("INSERT INTO settings (key, value) VALUES ('markets.budget.alphavantage.2026-11-04', '19')").run();
  const r = rig(clock);
  await r.job.run(clock.now);
  expect(r.tsxCalls).toEqual([["ATZ.TO"]]);
  expect(JSON.parse(getSetting(db, "markets.av.deferred")!)).toEqual(["VFV.TO", "XEQT.TO"]);
});

test("no Tiingo key: TSX still runs", async () => {
  hold("NOW", "US");
  hold("ATZ", "TSX");
  const clock = { now: Date.parse("2026-11-04T21:35:00Z") };
  const tsxCalls: string[][] = [];
  const data = { quotes: async (l: Instrument[]) => (tsxCalls.push(l.map(instrumentKey)), { quotes: [], missing: [] }), news: async () => [], prepare: async () => {} } as unknown as MarketData;
  await eodJob(db, { data, tiingo: () => null, now: () => clock.now }).run(clock.now);
  expect(tsxCalls).toEqual([["ATZ.TO", "XEQT.TO"]]);
});

test("after the close: the next 30 days of earnings for US stocks, and one news fetch", async () => {
  hold("RKLB", "US");
  watch("SPY", "US");
  const clock = { now: Date.parse("2026-11-04T21:35:00Z") };
  const asked: string[] = [];
  const research = {
    earnings: async (list: Instrument[], from: string, to: string) => {
      asked.push(`${list.map(instrumentKey).join(",")} ${from}..${to}`);
      return [{ key: "RKLB", date: "2026-11-10", hour: "amc", epsEstimate: 1.23 }];
    },
  };
  const data = {
    quotes: async () => ({ quotes: [], missing: [] }),
    news: async (list: Instrument[]) => (asked.push(`news ${list.map(instrumentKey).join(",")}`), []),
    research: () => research,
    prepare: async () => {},
  } as unknown as MarketData;
  const { createAlert } = await import("../../../src/engine/markets/alerts");
  createAlert(db, { spaceId, key: "RKLB", rule: { kind: "earnings_within", days: 10 } });
  await eodJob(db, { data, tiingo: () => null, now: () => clock.now }).run(clock.now);
  expect(asked).toEqual(["RKLB 2026-11-04..2026-12-04", "news RKLB"]);
  expect(db.query("SELECT topic FROM approvals WHERE kind = 'alert'").all()).toEqual([{ topic: "earnings" }]);
  expect(db.query("SELECT key, date, source FROM market_earnings").all()).toEqual([{ key: "RKLB", date: "2026-11-10", source: "finnhub" }]);
});

test("the end-of-day job queues thesis checks for earnings in the next days", async () => {
  hold("NOW", "US");
  const { saveNotes } = await import("../../../src/engine/markets/research");
  saveNotes(db, spaceId, "NOW", { thesis: "Platform wins." });
  const clock = { now: Date.parse("2026-11-04T21:35:00Z") };
  const data = {
    quotes: async () => ({ quotes: [], missing: [] }),
    news: async () => [],
    research: () => ({ earnings: async () => [{ key: "NOW", date: "2026-11-06", hour: "amc", epsEstimate: 1 }] }),
    prepare: async () => {},
  } as unknown as MarketData;
  await eodJob(db, { data, tiingo: () => null, now: () => clock.now }).run(clock.now);
  expect(db.query("SELECT title, purpose, agent FROM tasks").all()).toEqual([{ title: "Thesis check before NOW earnings on 2026-11-06", purpose: "thesis_check", agent: "claude" }]);
});

test("a split re-fetches the whole window so stored adjusted closes match (NOW 5:1: 1Y about +6%, no cliff)", async () => {
  const { closes } = await import("../../../src/engine/markets/closes");
  const { performance } = await import("../../../src/engine/markets/performance");
  hold("NOW", "US");
  const days = (from: string, to: string) => {
    const out: string[] = [];
    for (let t = Date.parse(`${from}T12:00:00Z`); t <= Date.parse(`${to}T12:00:00Z`); t += 86_400_000) {
      const d = new Date(t);
      if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
    }
    return out;
  };
  const row = (date: string, close: number, adjClose: number, splitFactor = 1) => ({ date: `${date}T00:00:00.000Z`, open: close, high: close, low: close, close, volume: 1, adjClose, adjOpen: adjClose, adjHigh: adjClose, adjLow: adjClose, adjVolume: 1, divCash: 0, splitFactor });
  // Before the split, Tiingo's adjusted closes equal the raw ones (~1000).
  const before = days("2025-10-01", "2026-11-03").map((d) => row(d, 1000, 1000));
  // After it, every earlier adjusted close is a fifth, and the split day says splitFactor 5.
  const after = [...days("2025-10-01", "2026-11-03").map((d) => row(d, 1000, 200)), row("2026-11-04", 212, 212, 5)];
  const s = stubFetch((url) => {
    const start = url.searchParams.get("startDate")!;
    return jsonResponse(start === "2026-11-04" ? after.slice(-1) : start <= "2025-10-01" && s.calls.length > 1 ? after : before);
  });
  const now = { now: Date.parse("2026-11-03T21:35:00Z") };
  const data = { quotes: async () => ({ quotes: [], missing: [] }), news: async () => [], prepare: async () => {} } as unknown as MarketData;
  const tiingo = () =>
    tiingoProvider("TGTEST12345", { fetch: s.fetch, now: () => now.now, budget: { day: dailyBudget(db, "tiingo", 950, () => now.now), hour: hourlyBudget(db, "tiingo", 48, () => now.now) }, symbols: tiingoSymbols(db, () => now.now) });
  await eodJob(db, { data, tiingo, now: () => now.now }).run(now.now);
  now.now = Date.parse("2026-11-04T21:35:00Z");
  await eodJob(db, { data, tiingo, now: () => now.now }).run(now.now);
  const nowCalls = s.calls.filter((c) => c.url.pathname.includes("/NOW/")).map((c) => c.url.searchParams.get("startDate"));
  expect(nowCalls).toEqual(["2025-09-29", "2026-11-04", "2025-09-30"]);
  expect(closes(db, "NOW", "2026-11-03")[0]!.adjClose).toBe(200);
  const r = performance({ holdings: [{ key: "NOW", quantity: 1, listingCcy: "USD" }], closes: (k, f) => closes(db, k, f), fxOn: () => 1.4, today: "2026-11-04" }, "1Y", []);
  expect(r.portfolioPct!).toBeCloseTo(6, 6);
});

test("no thesis checks while Advanced is off", async () => {
  setAdvanced(db, spaceId, false);
  hold("NOW", "US");
  const { saveNotes } = await import("../../../src/engine/markets/research");
  saveNotes(db, spaceId, "NOW", { thesis: "Platform wins." });
  const clock = { now: Date.parse("2026-11-04T21:35:00Z") };
  const data = {
    quotes: async () => ({ quotes: [], missing: [] }),
    news: async () => [],
    research: () => ({ earnings: async () => [{ key: "NOW", date: "2026-11-06", hour: "amc", epsEstimate: 1 }] }),
    prepare: async () => {},
  } as unknown as MarketData;
  await eodJob(db, { data, tiingo: () => null, now: () => clock.now }).run(clock.now);
  expect(db.query("SELECT 1 FROM tasks WHERE purpose = 'thesis_check'").all()).toEqual([]);
});

test("no end-of-day news fetch unless Advanced or a big-news alert needs it", async () => {
  setAdvanced(db, spaceId, false);
  hold("RKLB", "US");
  let newsCalls = 0;
  const data = { quotes: async () => ({ quotes: [], missing: [] }), news: async () => (newsCalls++, []), research: () => null, prepare: async () => {} } as unknown as MarketData;
  const at = Date.parse("2026-11-04T21:35:00Z");
  await eodJob(db, { data, tiingo: () => null, now: () => at }).run(at);
  expect(newsCalls).toBe(0);
});

// Finnhub's calendar as the audit found it: RKLB reports Mon Nov 9 after the close, QBTS Tue Nov 10; the others
// reported in October.
const CALENDAR: Record<string, { date: string; hour: string | null }> = { RKLB: { date: "2026-11-09", hour: "amc" }, QBTS: { date: "2026-11-10", hour: null } };
const finnhubCalendar = (asked: string[]) => ({
  earnings: async (list: Instrument[], from: string, to: string) => {
    asked.push(`${list.map(instrumentKey).join(",")} ${from}..${to}`);
    return list.flatMap((i) => {
      const e = CALENDAR[i.symbol];
      return e && e.date >= from && e.date <= to ? [{ key: i.symbol, date: e.date, hour: e.hour, epsEstimate: null }] : [];
    });
  },
});

test("run before any key exists, earnings are reported skipped; adding a Finnhub key fills RKLB Nov 9 and QBTS Nov 10", async () => {
  setAdvanced(db, spaceId, false);
  for (const s of ["RKLB", "QBTS", "AMZN", "SPY"]) hold(s, "US");
  const { createJobs } = await import("../../../src/engine/markets/jobs");
  const { earningsView } = await import("../../../src/engine/markets/views");
  const setup = Date.parse("2026-11-06T00:32:00Z"); // Thu Nov 5, 7:32 PM ET, the moment of setup
  const asked: string[] = [];
  let research: ReturnType<typeof finnhubCalendar> | null = null;
  const data = { quotes: async () => ({ quotes: [], missing: [] }), news: async () => [], research: () => research, prepare: async () => {} } as unknown as MarketData;
  let clock = setup;
  const jobs = createJobs(db, [eodJob(db, { data, tiingo: () => null, now: () => clock })], () => clock);
  expect(await jobs.runDue(setup)).toEqual(["eod"]);
  const st = jobs.status()[0]!;
  expect(st.lastError).toContain("Earnings dates weren't checked: add your Finnhub key in Settings → Market data.");
  expect(asked).toEqual([]);
  expect(earningsView(db, spaceId, setup).rows).toEqual([]);

  clock = Date.parse("2026-11-06T14:00:00Z");
  research = finnhubCalendar(asked);
  expect(await jobs.rerunSkipped(clock)).toEqual(["eod"]);
  expect(asked).toEqual(["RKLB,QBTS,AMZN 2026-11-06..2026-12-06"]);
  expect(earningsView(db, spaceId, clock).rows.map((r) => [r.key, r.date, r.hour])).toEqual([
    ["RKLB", "2026-11-09", "amc"],
    ["QBTS", "2026-11-10", null],
  ]);
  expect(jobs.status()[0]!.lastError).toBeNull();
});

test("the 16:30 job keeps US closes from Finnhub quotes, the close and the previous close, so sparklines fill", async () => {
  setAdvanced(db, spaceId, false);
  hold("AMZN", "US");
  hold("MARS", "US");
  const { spark } = await import("../../../src/engine/markets/views");
  const close = Date.parse("2026-11-06T21:00:00Z"); // Fri Nov 6, 4:00 PM ET
  const asked: string[][] = [];
  const quote = (key: string, price: number, prevClose: number, at: number) => ({ key, price, prevClose, at, source: "finnhub" as const, freshness: "live" as const });
  const data = {
    quotes: async (list: Instrument[]) => {
      asked.push(list.map(instrumentKey));
      return {
        // MARS last traded a few seconds before the bell; AMZN's quote is stamped at the close.
        quotes: list.map((i) => (i.symbol === "AMZN" ? quote("AMZN", 261.78, 260.21, close) : i.symbol === "MARS" ? quote("MARS", 21.43, 19.72, close - 12_000) : quote(instrumentKey(i), 600, 595, close))),
        missing: [],
      };
    },
    news: async () => [],
    research: () => finnhubCalendar([]),
    prepare: async () => {},
  } as unknown as MarketData;
  const at = Date.parse("2026-11-06T21:30:00Z");
  const r = await eodJob(db, { data, tiingo: () => null, now: () => at }).run(at);
  expect(asked[0]).toEqual(["AMZN", "MARS", "SPY"]);
  expect(closeOn(db, "AMZN", "2026-11-06")).toMatchObject({ close: 261.78, adjClose: null, source: "finnhub" });
  expect(closeOn(db, "AMZN", "2026-11-05")).toMatchObject({ close: 260.21, source: "finnhub" });
  expect(closeOn(db, "MARS", "2026-11-06")!.close).toBe(21.43);
  expect(spark(db, "AMZN", at)).toEqual([260.21, 261.78]);
  expect(r && r.skipped.filter((s) => s.reason)).toEqual([]);
});

test("a late after-hours quote isn't taken as the close, but its previous close is", async () => {
  setAdvanced(db, spaceId, false);
  hold("AMZN", "US");
  const data = {
    quotes: async (list: Instrument[]) => ({
      quotes: list.map((i) => ({ key: instrumentKey(i), price: 263, prevClose: 260.21, at: Date.parse("2026-11-06T23:30:00Z"), source: "finnhub", freshness: "live" })),
      missing: [],
    }),
    news: async () => [],
    research: () => finnhubCalendar([]),
    prepare: async () => {},
  } as unknown as MarketData;
  const at = Date.parse("2026-11-07T00:00:00Z");
  await eodJob(db, { data, tiingo: () => null, now: () => at }).run(at);
  expect(closeOn(db, "AMZN", "2026-11-06")).toBeNull();
  expect(closeOn(db, "AMZN", "2026-11-05")!.close).toBe(260.21);
});
