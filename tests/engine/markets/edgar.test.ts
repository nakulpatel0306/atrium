import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../../src/engine/db";
import { setSetting } from "../../../src/engine/settings";
import { createSpace } from "../../../src/engine/spaces";
import { crossCheck, EDGAR_USER_AGENT, edgarEpsTtm, refreshEdgar } from "../../../src/engine/markets/edgar";
import { tempHome } from "../../helpers";
import { fixture, jsonResponse, stubFetch } from "./fakes";

let home: ReturnType<typeof tempHome>;
let db: Database;
beforeEach(() => {
  home = tempHome();
  db = openDb();
});
afterEach(() => {
  db.close();
  home.cleanup();
});

const facts = () => JSON.parse(fixture("investing/edgar-facts-now.json"));
const NOW = Date.parse("2026-11-07T15:05:00Z");

test("EPS over the last four quarters, deriving Q4 from the annual filing", () => {
  // Q4 2025 = 6.00 − (1.40 + 1.50 + 1.55) = 1.55; then 1.60, 1.70, 1.75.
  expect(edgarEpsTtm(facts())).toEqual({ eps: 6.6, through: "2026-09-30" });
});

test("fewer than four quarters is null", () => {
  const f = facts();
  const rows = f.facts["us-gaap"].EarningsPerShareDiluted.units["USD/shares"] as { end: string; form: string }[];
  f.facts["us-gaap"].EarningsPerShareDiluted.units["USD/shares"] = rows.filter((r) => r.end >= "2026-01-01");
  expect(edgarEpsTtm(f)).toBeNull();
  expect(edgarEpsTtm({})).toBeNull();
});

test("crossCheck flags a P/E more than 10% off", () => {
  expect(crossCheck(50, 100, 1.8)).toEqual({ edgarPe: 55.56, differs: false });
  expect(crossCheck(50, 100, 1.2)).toEqual({ edgarPe: 83.33, differs: true });
  expect(crossCheck(null, 100, 1.2)).toEqual({ edgarPe: 83.33, differs: false });
  expect(crossCheck(50, 100, null)).toEqual({ edgarPe: null, differs: false });
  expect(crossCheck(50, 100, -0.5)).toEqual({ edgarPe: null, differs: false });
});

test("EDGAR is asked politely, for US stocks only, and not at all when off", async () => {
  const space = createSpace(db, { name: "Investing", kind: "markets", goal: "g" });
  for (const [s, e] of [["NOW", "US"], ["SPY", "US"], ["ATZ", "TSX"]] as const) {
    db.query("INSERT INTO market_watchlist (space_id, symbol, exchange, name, added_at) VALUES (?, ?, ?, '', 1)").run(space.id, s, e);
  }
  const s = stubFetch((url) => jsonResponse(fixture(url.host === "www.sec.gov" ? "investing/edgar-tickers.json" : "investing/edgar-facts-now.json")));
  const sleeps: number[] = [];
  const deps = { fetch: s.fetch, now: () => NOW, sleep: async (ms: number) => void sleeps.push(ms) };
  await refreshEdgar(db, deps);
  expect(EDGAR_USER_AGENT).toBe("Atrium personal dashboard 123441573+nakulpatel0306@users.noreply.github.com");
  expect(s.calls.map((c) => c.url.href)).toEqual([
    "https://www.sec.gov/files/company_tickers_exchange.json",
    "https://data.sec.gov/api/xbrl/companyfacts/CIK0001373715.json",
  ]);
  for (const c of s.calls) expect(c.headers["user-agent"]).toBe(EDGAR_USER_AGENT);
  expect(sleeps).toEqual([200]);
  expect(db.query("SELECT edgar_eps_ttm, edgar_at FROM instrument_meta WHERE key = 'NOW'").get()).toEqual({ edgar_eps_ttm: 6.6, edgar_at: NOW });
  // A month later nothing is due yet the next day, and the ticker map is cached.
  await refreshEdgar(db, { ...deps, now: () => NOW + 86_400_000 });
  expect(s.calls).toHaveLength(2);
  setSetting(db, "markets.edgar", "off");
  db.query("UPDATE instrument_meta SET edgar_at = 0").run();
  await refreshEdgar(db, deps);
  expect(s.calls).toHaveLength(2);
});
