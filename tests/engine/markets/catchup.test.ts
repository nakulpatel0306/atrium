import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../../src/engine/db";
import { createSpace } from "../../../src/engine/spaces";
import { createCatchUp, earningsStale } from "../../../src/engine/markets/catchup";
import type { MarketData } from "../../../src/engine/markets/data";
import { eodJob } from "../../../src/engine/markets/eod";
import { instrumentKey, type Instrument } from "../../../src/engine/markets/instrument";
import { createJobs } from "../../../src/engine/markets/jobs";
import { getMeta, metaJob, metaStale } from "../../../src/engine/markets/meta";
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
  expect(r.jobs.status().every((j) => j.lastError === null)).toBe(true);
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
  expect(r.calls).toContain("earnings RKLB,QBTS,META,SOFI");
  expect(r.calls).toContain("profile SOFI");
});

test("two catch-ups at once share one run", async () => {
  const r = rig();
  r.state.keyed = true;
  await Promise.all([r.catchUp.run(true), r.catchUp.run(true)]);
  expect(r.calls.filter((c) => c.startsWith("earnings"))).toHaveLength(1);
});
