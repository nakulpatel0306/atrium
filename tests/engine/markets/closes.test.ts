import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../../src/engine/db";
import { setSetting } from "../../../src/engine/settings";
import { closeCount, closeOn, closes, recordCloses } from "../../../src/engine/markets/closes";
import { createMarketData } from "../../../src/engine/markets/data";
import type { Keychain } from "../../../src/engine/markets/keychain";
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

test("a lower-ranked source never replaces a higher-ranked close", () => {
  recordCloses(db, "SPY", [{ date: "2026-11-04", close: 600, adjClose: 598, source: "tiingo" }]);
  recordCloses(db, "SPY", [
    { date: "2026-11-04", close: 601, adjClose: null, source: "finnhub" },
    { date: "2026-11-05", close: 603, adjClose: null, source: "finnhub" },
  ]);
  expect(closeOn(db, "SPY", "2026-11-04")).toEqual({ date: "2026-11-04", close: 600, adjClose: 598, source: "tiingo" });
  recordCloses(db, "SPY", [{ date: "2026-11-05", close: 602.5, adjClose: 601, source: "tiingo" }]);
  expect(closeOn(db, "SPY", "2026-11-05")!.source).toBe("tiingo");
  recordCloses(db, "SPY", [{ date: "2026-11-02", close: 590, adjClose: null, source: "alpaca" }]);
  expect(closes(db, "SPY", "2026-11-01").map((c) => c.date)).toEqual(["2026-11-02", "2026-11-04", "2026-11-05"]);
  expect(closes(db, "SPY", "2026-11-03").map((c) => c.date)).toEqual(["2026-11-04", "2026-11-05"]);
  expect(closeCount(db, "SPY")).toBe(3);
  expect(closeOn(db, "SPY", "2026-11-03")).toBeNull();
});

test("demo closes are kept apart from real ones", () => {
  recordCloses(db, "AAPL", [{ date: "2026-11-04", close: 1, adjClose: null, source: "demo" }]);
  expect(closeCount(db, "AAPL")).toBe(0);
  setSetting(db, "markets.provider", "demo");
  recordCloses(db, "AAPL", [{ date: "2026-11-04", close: 1, adjClose: null, source: "demo" }]);
  expect(closes(db, "AAPL", "2026-01-01")).toHaveLength(1);
  setSetting(db, "markets.provider", "finnhub");
  expect(closes(db, "AAPL", "2026-01-01")).toHaveLength(0);
  expect(closeCount(db, "AAPL")).toBe(0);
});

test("Alpha Vantage daily answers become Atrium's own closes", async () => {
  const keychain: Keychain = { get: async (a) => (a === "alphavantage.key" ? "AVTEST12345" : null), set: async () => {}, remove: async () => {} };
  const now = Date.parse("2026-11-04T22:00:00Z");
  const data = createMarketData({ db, keychain, fetch: stubFetch(() => jsonResponse(fixture("av-daily-shop.json"))).fetch, now: () => now });
  await data.quotes([{ symbol: "SHOP", exchange: "TSX" }]);
  expect(closeOn(db, "SHOP.TO", "2026-11-04")).toEqual({ date: "2026-11-04", close: 153.9, adjClose: null, source: "alphavantage" });
  expect(closeCount(db, "SHOP.TO")).toBeGreaterThan(2);
});
