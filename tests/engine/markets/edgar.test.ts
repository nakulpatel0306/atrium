import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../../src/engine/db";
import { setSetting } from "../../../src/engine/settings";
import { createSpace } from "../../../src/engine/spaces";
import { crossCheck, edgarStatus, edgarUserAgent, edgarEpsTtm, refreshEdgar, setEdgarContact } from "../../../src/engine/markets/edgar";
import { dataBudget } from "../../../src/engine/markets/budget";
import { addToWatchlist } from "../../../src/engine/markets/watchlist";
import type { Exchange } from "../../../src/engine/markets/instrument";
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

test("EDGAR is off until Nakul gives a contact, then asked politely, for US stocks only", async () => {
  const space = createSpace(db, { name: "Investing", kind: "markets", goal: "g" });
  for (const [s, e] of [["NOW", "US"], ["SPY", "US"], ["ATZ", "TSX"]] as const) {
    addToWatchlist(db, space.id, { symbol: s, exchange: e as Exchange });
  }
  const s = stubFetch((url) => jsonResponse(fixture(url.host === "www.sec.gov" ? "investing/edgar-tickers.json" : "investing/edgar-facts-now.json")));
  const sleeps: number[] = [];
  const deps = { fetch: s.fetch, now: () => NOW, sleep: async (ms: number) => void sleeps.push(ms) };
  await refreshEdgar(db, deps);
  expect(s.calls).toHaveLength(0);
  expect(edgarStatus(db, NOW)).toEqual({ on: false, contact: null, pausedUntil: null, note: "Off · add a contact email to turn it on" });
  expect(dataBudget(db, NOW).find((r) => r.source === "edgar")).toMatchObject({ lastError: null, note: "Off · add a contact email to turn it on" });
  expect(() => setEdgarContact(db, "not an email")).toThrow("Type an email address like you@example.com.");
  setEdgarContact(db, "nakul@example.com");
  await refreshEdgar(db, deps);
  expect(edgarUserAgent("nakul@example.com")).toBe("Atrium personal dashboard nakul@example.com");
  expect(s.calls.map((c) => c.url.href)).toEqual([
    "https://www.sec.gov/files/company_tickers_exchange.json",
    "https://data.sec.gov/api/xbrl/companyfacts/CIK0001373715.json",
  ]);
  for (const c of s.calls) expect(c.headers["user-agent"]).toBe("Atrium personal dashboard nakul@example.com");
  expect(sleeps).toEqual([200]);
  expect(db.query("SELECT edgar_eps_ttm, edgar_at FROM instrument_meta WHERE key = 'NOW'").get()).toEqual({ edgar_eps_ttm: 6.6, edgar_at: NOW });
  // The next day nothing is due, and the ticker map is cached.
  await refreshEdgar(db, { ...deps, now: () => NOW + 86_400_000 });
  expect(s.calls).toHaveLength(2);
  setSetting(db, "markets.edgar", "off");
  db.query("UPDATE instrument_meta SET edgar_at = 0").run();
  await refreshEdgar(db, deps);
  expect(s.calls).toHaveLength(2);
});

test("a refusal from SEC pauses the cross-check for a month, quietly", async () => {
  const space = createSpace(db, { name: "Investing", kind: "markets", goal: "g" });
  addToWatchlist(db, space.id, { symbol: "NOW", exchange: "US" });
  setEdgarContact(db, "nakul@example.com");
  const s = stubFetch(() => new Response("Undeclared Automated Tool", { status: 403 }));
  await refreshEdgar(db, { fetch: s.fetch, now: () => NOW, sleep: async () => {} });
  expect(s.calls).toHaveLength(1);
  const st = edgarStatus(db, NOW);
  expect(st.pausedUntil).toBe(NOW + 30 * 86_400_000);
  expect(st.note).toBe("Paused: SEC refused requests from this contact. Atrium tries again on Dec 7.");
  expect(dataBudget(db, NOW).find((r) => r.source === "edgar")!.lastError).toBeNull();
  await refreshEdgar(db, { fetch: s.fetch, now: () => NOW + 10 * 86_400_000, sleep: async () => {} });
  expect(s.calls).toHaveLength(1);
  // A new contact is worth trying straight away.
  setEdgarContact(db, "other@example.com");
  await refreshEdgar(db, { fetch: s.fetch, now: () => NOW + 10 * 86_400_000, sleep: async () => {} });
  expect(s.calls).toHaveLength(2);
});
