import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../../../src/engine/db";
import { createSpace } from "../../../src/engine/spaces";
import type { MarketData } from "../../../src/engine/markets/data";
import { parseIshares } from "../../../src/engine/markets/funds/parse-ishares";
import { parseSsga } from "../../../src/engine/markets/funds/parse-ssga";
import { saveFundFile } from "../../../src/engine/markets/funds/store";
import { getMeta, metaFromFunds, metaJob } from "../../../src/engine/markets/meta";
import type { MarketProvider } from "../../../src/engine/markets/providers/types";
import { setSetting } from "../../../src/engine/settings";
import { tempHome } from "../../helpers";
import { fixture, jsonResponse, stubFetch } from "./fakes";

let home: ReturnType<typeof tempHome>;
let db: Database;
let spaceId: string;
const DIR = join(import.meta.dir, "../../fixtures/markets/investing");
beforeEach(() => {
  home = tempHome();
  db = openDb();
  spaceId = createSpace(db, { name: "Investing", kind: "markets", goal: "g" }).id;
  for (const [s, e] of [["ATZ", "TSX"], ["NOW", "US"], ["XEQT", "TSX"], ["RKLB", "US"], ["ABCX", "US"]] as const) {
    db.query("INSERT INTO market_watchlist (space_id, symbol, exchange, name, added_at) VALUES (?, ?, ?, '', 1)").run(spaceId, s, e);
  }
});
afterEach(() => {
  db.close();
  home.cleanup();
});

const NOW = Date.parse("2026-11-07T15:05:00Z");

function saveFixtures() {
  saveFundFile(db, parseSsga(new Uint8Array(readFileSync(join(DIR, "ssga-spy.xlsx"))), "SPY"), NOW);
  saveFundFile(db, parseIshares(readFileSync(join(DIR, "ishares-xeqt.csv"), "utf8"), "XEQT.TO", "ishares-ca"), NOW);
}

test("sectors and countries come from fund files, iShares first", () => {
  saveFixtures();
  expect(metaFromFunds(db)).toBeGreaterThanOrEqual(2);
  const m = getMeta(db, ["ATZ.TO", "NOW"]);
  expect(m.get("ATZ.TO")).toMatchObject({ sector: "Consumer Discretionary", country: "Canada", currency: "CAD", sectorSource: "iShares holdings file · Nov 4" });
  expect(m.get("NOW")).toMatchObject({ sector: "Information Technology", country: "United States", currency: "USD" });
});

test("the meta job marks ETFs and fetches profile and metrics for US stocks only", async () => {
  saveFixtures();
  const asked: string[] = [];
  const research = {
    async profile(i: { symbol: string }) {
      asked.push(`profile ${i.symbol}`);
      return { name: `${i.symbol} Inc`, country: "US", currency: "USD", industry: "Aerospace & Defense" };
    },
    async metric(i: { symbol: string }) {
      asked.push(`metric ${i.symbol}`);
      return { pe: 50, high52: 80, low52: 20, divYield: null };
    },
  } as unknown as MarketProvider;
  const data = { research: () => research, prepare: async () => {} } as unknown as MarketData;
  const edgar = stubFetch((url) => jsonResponse(fixture(url.host === "www.sec.gov" ? "investing/edgar-tickers.json" : "investing/edgar-facts-now.json")));
  setSetting(db, "markets.edgar.contact", "nakul@example.com");
  const job = metaJob(db, { data, now: () => NOW, fetch: edgar.fetch, sleep: async () => {} });
  expect(job).toMatchObject({ name: "meta", slot: { at: "10:00", days: [6] } });
  await job.run(NOW);
  expect(asked.sort()).toEqual(["metric ABCX", "metric NOW", "metric RKLB", "profile ABCX", "profile NOW", "profile RKLB"]);
  const m = getMeta(db, ["XEQT.TO", "NOW", "RKLB", "ABCX", "ATZ.TO"]);
  expect(m.get("XEQT.TO")!.kind).toBe("etf");
  expect(m.get("NOW")).toMatchObject({ kind: "stock", pe: 50, high52: 80, metricsAt: NOW, sector: "Information Technology" });
  // A fund file's GICS sector wins over Finnhub's industry; a stock in no fund file gets the industry.
  expect(m.get("RKLB")).toMatchObject({ name: "RKLB Inc", sector: "Industrials", sectorSource: "iShares holdings file · Nov 4" });
  expect(m.get("ABCX")).toMatchObject({ name: "ABCX Inc", sector: "Aerospace & Defense", sectorSource: "Finnhub industry" });
  // EDGAR: the ticker list, then NOW and RKLB (ABCX has no CIK in the fixture).
  expect(edgar.calls.map((c) => c.url.pathname)).toEqual(["/files/company_tickers_exchange.json", "/api/xbrl/companyfacts/CIK0001373715.json", "/api/xbrl/companyfacts/CIK0001819994.json"]);
  asked.length = 0;
  await job.run(NOW + 86_400_000);
  expect(asked).toEqual([]);
  expect(edgar.calls).toHaveLength(3);
});

test("with EDGAR off the meta job never asks it", async () => {
  setSetting(db, "markets.edgar", "off");
  const edgar = stubFetch(() => jsonResponse({}));
  const data = { research: () => null, prepare: async () => {} } as unknown as MarketData;
  await metaJob(db, { data, now: () => NOW, fetch: edgar.fetch }).run(NOW);
  expect(edgar.calls).toHaveLength(0);
});
