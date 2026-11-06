import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../../src/engine/db";
import { saveEarnings } from "../../../src/engine/markets/events";
import { addHolding } from "../../../src/engine/markets/holdings";
import { addToList, createList } from "../../../src/engine/markets/lists";
import { saveWriteup } from "../../../src/engine/markets/research";
import { createSpace } from "../../../src/engine/spaces";
import { earningsView, glanceView, listsView, portfolioView, SPARK_DAYS } from "../../../src/engine/markets/views";
import { tempHome } from "../../helpers";
import { FX, NOW, simpleFixture, viewData } from "./simple-fixture";

let home: ReturnType<typeof tempHome>;
let db: Database;
let fx: ReturnType<typeof simpleFixture>;
beforeEach(() => {
  home = tempHome();
  db = openDb();
  fx = simpleFixture(db);
});
afterEach(() => {
  db.close();
  home.cleanup();
});

test("portfolioView totals in CAD, mixes sources and orders rows by value", () => {
  const v = portfolioView(db, viewData(), fx.spaceId, NOW);
  expect(v.total!.value).toBeCloseTo(10 * 250 * FX + 100 * 35, 2);
  expect(v.mix).toContain("real-time");
  expect(v.mix).toContain("close");
  expect(v.empty).toBe(false);
  expect(v.holdings.map((h) => h.key)).toEqual(["XEQT.TO", "AMZN"]);
  const amzn = v.holdings.find((h) => h.key === "AMZN")!;
  expect(amzn.spark).toHaveLength(SPARK_DAYS);
  expect(amzn.gainCad).not.toBeNull();
  expect(amzn.dayPct).toBeCloseTo(2.04, 1);
  expect(amzn.tv).toBe("NASDAQ:AMZN");
  expect(v.note).toBeNull();
  saveWriteup(db, { spaceId: fx.spaceId, kind: "digest", key: null, forDate: "2026-11-04", body: "**Up** on news", taskId: null });
  expect(portfolioView(db, viewData(), fx.spaceId, NOW).note?.body).toBe("**Up** on news");
});

test("a digest from three sessions ago isn't today's note", () => {
  saveWriteup(db, { spaceId: fx.spaceId, kind: "digest", key: null, forDate: "2026-10-30", body: "old", taskId: null });
  expect(portfolioView(db, viewData(), fx.spaceId, NOW).note).toBeNull();
});

test("the same key in two accounts is one row with summed quantity", () => {
  addHolding(db, fx.spaceId, { account: "RRSP", symbol: "AMZN", exchange: "US", name: "Amazon", quantity: 5, bookValue: 1000, currency: "USD" });
  const rows = portfolioView(db, viewData(), fx.spaceId, NOW).holdings.filter((h) => h.key === "AMZN");
  expect(rows).toHaveLength(1);
  expect(rows[0]!.quantity).toBe(15);
  expect(rows[0]!.valueCad).toBeCloseTo(15 * 250 * FX, 2);
});

test("no holdings → empty true, total null", () => {
  const s = createSpace(db, { name: "Other", kind: "markets", goal: "g" });
  const v = portfolioView(db, viewData(), s.id, NOW);
  expect(v.empty).toBe(true);
  expect(v.total).toBeNull();
  expect(v.holdings).toEqual([]);
});

test("listsView returns lists in order with prices or the reason there's none", () => {
  const ideas = createList(db, fx.spaceId, "Ideas");
  addToList(db, ideas.id, { symbol: "NVDA", exchange: "US" });
  addToList(db, ideas.id, { symbol: "AAPL", exchange: "NEO" });
  const v = listsView(db, viewData(), fx.spaceId, NOW);
  expect(v.lists.map((l) => l.name)).toEqual(["Holdings", "Ideas"]);
  expect(v.lists[0]!.rows.map((r) => r.key)).toEqual(["AMZN", "XEQT.TO"]);
  const [nvda, cdr] = v.lists[1]!.rows;
  expect(nvda!.price).toBeNull();
  expect(nvda!.missing).toBe("No price yet; Atrium checks again during market hours.");
  expect(cdr!.missing).toBe("No free source covers NEO-listed CDRs.");
});

test("earningsView covers two weeks of holdings and lists; your own date wins", () => {
  addToList(db, fx.holdingsList, { symbol: "NVDA", exchange: "US" });
  addToList(db, fx.holdingsList, { symbol: "NOW", exchange: "US" });
  saveEarnings(db, [
    { key: "AMZN", date: "2026-11-12", hour: "amc", epsEstimate: 1.23 },
    { key: "NVDA", date: "2026-11-10", hour: "bmo", epsEstimate: null },
    { key: "NOW", date: "2026-11-09", hour: null, epsEstimate: null },
    { key: "AMZN", date: "2026-11-25", hour: null, epsEstimate: null },
  ], "finnhub");
  saveEarnings(db, [{ key: "NOW", date: "2026-11-11", hour: "amc", epsEstimate: null }], "you");
  const v = earningsView(db, fx.spaceId, NOW);
  expect(v.rows.map((r) => [r.key, r.date, r.source, r.held])).toEqual([
    ["NVDA", "2026-11-10", "finnhub", false],
    ["NOW", "2026-11-11", "you", false],
    ["AMZN", "2026-11-12", "finnhub", true],
  ]);
  expect(v.source).toMatch(/^Finnhub earnings calendar · checked [A-Z][a-z]{2} \d{1,2}$/);
  const empty = createSpace(db, { name: "E", kind: "markets", goal: "g" });
  expect(earningsView(db, empty.id, NOW)).toEqual({ rows: [], source: "No earnings dates yet. Atrium checks Finnhub after each close." });
});

test("glanceView tags closing prices", () => {
  const g = glanceView(db, viewData(), fx.spaceId, NOW);
  expect(g.portfolio!.totalCad).toBeCloseTo(10 * 250 * FX + 3500, 2);
  expect(g.lists[0]!.rows).toEqual([
    { key: "AMZN", price: 250, ccy: "USD", dayPct: expect.any(Number), tag: null },
    { key: "XEQT.TO", price: 35, ccy: "CAD", dayPct: expect.any(Number), tag: "close Nov 4" },
  ]);
  expect(g.advanced).toBe(false);
});

test("a sparkline falls back to cached daily bars until Atrium has closes", async () => {
  const { saveBars } = await import("../../../src/engine/markets/cache");
  const { spark } = await import("../../../src/engine/markets/views");
  expect(spark(db, "NVDA", NOW)).toEqual([]);
  saveBars(db, "NVDA", "1Day", [1, 2, 3].map((n) => ({ t: (NOW - (4 - n) * 86_400_000) / 1000, o: n, h: n, l: n, c: 100 + n, v: 1 })));
  expect(spark(db, "NVDA", NOW)).toEqual([101, 102, 103]);
  expect(spark(db, "AMZN", NOW)).toHaveLength(30);
});

test("holdings without a price are named under the total", () => {
  db.query("DELETE FROM market_quotes WHERE key = 'XEQT.TO'").run();
  const noAv = viewData({ reasonFor: (i) => (i.exchange === "TSX" ? "Not priced yet. Yahoo Finance fills in during TSX hours (9:30 AM to 4:00 PM ET)." : null) });
  const v = portfolioView(db, noAv, fx.spaceId, NOW);
  expect(v.left).toBe("1 Canadian holding isn't in the total yet. Yahoo Finance prices it during TSX hours (9:30 AM to 4:00 PM ET).");
  expect(v.total!.value).toBeCloseTo(10 * 250 * FX, 2);
  expect(portfolioView(db, viewData(), fx.spaceId, NOW).left).toBe("1 holding has no price yet and isn't in the total.");
});
