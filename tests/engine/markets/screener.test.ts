import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../../src/engine/db";
import { setSetting } from "../../../src/engine/settings";
import { createSpace } from "../../../src/engine/spaces";
import { saveQuotes } from "../../../src/engine/markets/cache";
import { recordCloses } from "../../../src/engine/markets/closes";
import { createMarketData } from "../../../src/engine/markets/data";
import { applyFilters, screenRows, type ScreenRow } from "../../../src/engine/markets/screener";
import { addToWatchlist } from "../../../src/engine/markets/watchlist";
import { tempHome } from "../../helpers";

let home: ReturnType<typeof tempHome>;
let db: Database;
let spaceId: string;
beforeEach(() => {
  home = tempHome();
  db = openDb();
  spaceId = createSpace(db, { name: "Investing", kind: "markets", goal: "g" }).id;
  setSetting(db, "markets.provider", "finnhub");
});
afterEach(() => {
  db.close();
  home.cleanup();
});

const keys: Record<string, string> = { "finnhub.token": "FHTEST12345" };
const data = () => createMarketData({ db, keychain: { get: async (a) => keys[a] ?? null, set: async () => {}, remove: async () => {} } });
function dates(n: number): string[] {
  const out: string[] = [];
  for (let t = Date.now() - 86_400_000; out.length < n; t -= 86_400_000) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.unshift(d.toISOString().slice(0, 10));
  }
  return out;
}

test("52-week position from Atrium's own closes when it has a year of them", async () => {
  const d = data();
  await d.refreshKeys(true);
  addToWatchlist(db, spaceId, { symbol: "NOW", exchange: "US" }, "ServiceNow");
  const ds = dates(252);
  recordCloses(db, "NOW", ds.map((date, i) => ({ date, close: i === 0 ? 80 : i === 1 ? 120 : 100, adjClose: null, source: "tiingo" })));
  saveQuotes(db, [{ key: "NOW", price: 110, prevClose: 100, at: Date.now(), source: "finnhub", freshness: "live" }]);
  const [r] = screenRows(db, d, spaceId);
  expect(r).toMatchObject({ key: "NOW", name: "ServiceNow", held: false, stage: "watching", range52Source: "Atrium's stored closes" });
  expect(r!.pos52).toBeCloseTo(0.75, 9);
  expect(r!.fromHighPct).toBeCloseTo(-8.33, 2);
  expect(r!.price!.source).toBe("Finnhub · real-time");
  expect(r!.rsi14).not.toBeNull();
});

test("with a short history the range comes from Finnhub's metrics", async () => {
  const d = data();
  await d.refreshKeys(true);
  addToWatchlist(db, spaceId, { symbol: "RKLB", exchange: "US" });
  recordCloses(db, "RKLB", dates(50).map((date) => ({ date, close: 50, adjClose: null, source: "tiingo" })));
  db.query("INSERT INTO instrument_meta (key, pe, high52, low52, div_yield, metrics_at) VALUES ('RKLB', 80, 60, 20, 1.5, ?)").run(Date.parse("2026-11-01T15:00:00Z"));
  saveQuotes(db, [{ key: "RKLB", price: 50, prevClose: 49, at: Date.now(), source: "finnhub", freshness: "live" }]);
  const [r] = screenRows(db, d, spaceId);
  expect(r!.range52Source).toBe("Finnhub · metrics Nov 1");
  expect(r!.pos52).toBeCloseTo(0.75, 9);
  expect(r!.pe).toMatchObject({ value: 80, source: "Finnhub · metrics Nov 1" });
  expect(r!.divYield).toMatchObject({ value: 1.5, source: "Finnhub · metrics Nov 1" });
});

test("filters drop rows outside a range and rows without the field", () => {
  const row = (key: string, rsi14: number | null): ScreenRow => ({ key, name: key, price: null, pe: null, pos52: null, fromHighPct: null, rsi14, divYield: null, held: false, stage: "watching", range52Source: null });
  const rows = [row("A", 25), row("B", 45), row("C", null)];
  expect(applyFilters(rows, [{ field: "rsi14", max: 30 }]).map((r) => r.key)).toEqual(["A"]);
  expect(applyFilters(rows, [{ field: "rsi14", min: 30 }]).map((r) => r.key)).toEqual(["B"]);
  expect(applyFilters(rows, []).map((r) => r.key)).toEqual(["A", "B", "C"]);
});
