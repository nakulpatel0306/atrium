import { expect, test } from "bun:test";
import { openDb } from "../../../src/engine/db";
import { createSpace } from "../../../src/engine/spaces";
import { createCatchUp, earningsStale } from "../../../src/engine/markets/catchup";
import type { MarketData } from "../../../src/engine/markets/data";
import { eodJob } from "../../../src/engine/markets/eod";
import { instrumentKey, type Instrument } from "../../../src/engine/markets/instrument";
import { createJobs } from "../../../src/engine/markets/jobs";
import { metaJob } from "../../../src/engine/markets/meta";
import { tempHome } from "../../helpers";

// Review repro. Nakul's setup: Finnhub key, no Tiingo, so us-history is off for good after the first 16:30 run. That
// must not stand in for "eod already caught up": SOFI, added the next morning, gets its earnings date.
test("no Tiingo: a holding added after the 16:30 run still gets its earnings on catch-up", async () => {
  const home = tempHome();
  const db = openDb();
  const spaceId = createSpace(db, { name: "Investing", kind: "markets", goal: "g" }).id;
  const add = (s: string) =>
    db.query("INSERT INTO market_holdings (id, space_id, account, symbol, exchange, quantity, currency, source, updated_at) VALUES (?, ?, 'TFSA', ?, 'US', 1, 'USD', 'manual', 1)").run(`h_${s}`, spaceId, s);
  add("RKLB");
  const calls: string[] = [];
  const research = {
    async earnings(list: Instrument[]) {
      calls.push(`earnings ${list.map(instrumentKey).join(",")}`);
      return [];
    },
    async profile(i: Instrument) {
      calls.push(`profile ${i.symbol}`);
      return { name: i.symbol, country: "US", currency: "USD", industry: null, exchange: "NASDAQ" };
    },
    async metric(i: Instrument) {
      calls.push(`metric ${i.symbol}`);
      return { pe: 1, high52: 1, low52: 1, divYield: 0, marketCap: 1 };
    },
  };
  let clock = Date.parse("2026-11-09T21:30:00Z"); // Mon 4:30 PM ET
  const now = () => clock;
  const data = {
    quotes: async () => ({ quotes: [], missing: [] }),
    news: async () => [],
    research: () => research,
    status: async () => ({ keys: { alphavantage: false } }),
    prepare: async () => {},
  } as unknown as MarketData;
  const jobs = createJobs(db, [eodJob(db, { data, tiingo: () => null, now }), metaJob(db, { data, now })], now);
  const catchUp = createCatchUp(db, { jobs, now });
  await jobs.runDue(clock);
  expect(jobs.steps("eod")["us-history"]).toEqual({ status: "off", reason: null });
  clock = Date.parse("2026-11-10T15:00:00Z"); // Tue 10 AM, Nakul imports SOFI
  add("SOFI");
  expect(earningsStale(db, clock)).toBe(true);
  calls.length = 0;
  await catchUp.run(true);
  expect(calls).toContain("earnings SOFI");
  expect(earningsStale(db, clock)).toBe(false);
  // The hourly check after that has nothing to do: no reruns of steps that are off.
  calls.length = 0;
  clock += 61 * 60_000;
  expect(await catchUp.run()).toEqual([]);
  expect(calls).toEqual([]);
  db.close();
  home.cleanup();
});
