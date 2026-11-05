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
import { tempHome } from "../../helpers";
import { fixture, jsonResponse, stubFetch } from "./fakes";

let home: ReturnType<typeof tempHome>;
let db: Database;
let spaceId: string;
beforeEach(() => {
  home = tempHome();
  db = openDb();
  spaceId = createSpace(db, { name: "Investing", kind: "markets", goal: "g" }).id;
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
  db.query("INSERT INTO market_watchlist (space_id, symbol, exchange, name, added_at) VALUES (?, ?, ?, '', 1)").run(spaceId, symbol, exchange);

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
