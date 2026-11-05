import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../../src/engine/db";
import { bus } from "../../../src/engine/events";
import { createSpace } from "../../../src/engine/spaces";
import { addHolding, listHoldings, removeHolding, replaceImported, updateHolding, type HoldingInput } from "../../../src/engine/markets/holdings";
import { addToWatchlist, listWatchlist, removeFromWatchlist } from "../../../src/engine/markets/watchlist";
import { tempHome } from "../../helpers";

let home: ReturnType<typeof tempHome>;
let db: Database;
let spaceId: string;

beforeEach(() => {
  home = tempHome();
  db = openDb();
  spaceId = createSpace(db, { name: "Stocks", kind: "markets", goal: "watch" }).id;
});
afterEach(() => {
  db.close();
  home.cleanup();
});

test("watchlist adds once and removes by key", () => {
  const a = addToWatchlist(db, spaceId, { symbol: "SHOP", exchange: "TSX" }, "Shopify");
  expect(a).toMatchObject({ symbol: "SHOP", exchange: "TSX", key: "SHOP.TO", name: "Shopify" });
  addToWatchlist(db, spaceId, { symbol: "SHOP", exchange: "TSX" });
  addToWatchlist(db, spaceId, { symbol: "AAPL", exchange: "US" });
  expect(listWatchlist(db, spaceId).map((w) => w.key)).toEqual(["SHOP.TO", "AAPL"]);
  expect(listWatchlist(db, spaceId)[0]!.name).toBe("Shopify");
  removeFromWatchlist(db, spaceId, "SHOP.TO");
  expect(listWatchlist(db, spaceId).map((w) => w.key)).toEqual(["AAPL"]);
});

const h = (account: string, symbol: string, quantity = 10): HoldingInput => ({
  account,
  symbol,
  exchange: "TSX",
  name: symbol,
  quantity,
  bookValue: 100,
  currency: "CAD",
});

test("holdings CRUD; key equals instrumentKey; quantity must be positive", () => {
  let changed = 0;
  const off = bus.on((e) => void (e.type === "changed" && changed++));
  const x = addHolding(db, spaceId, h("TFSA", "SHOP"));
  expect(x.key).toBe("SHOP.TO");
  expect(x.source).toBe("manual");
  expect(updateHolding(db, x.id, { quantity: 12 }).quantity).toBe(12);
  expect(() => addHolding(db, spaceId, h("TFSA", "SHOP", 0))).toThrow("Quantity must be more than zero.");
  expect(() => updateHolding(db, x.id, { quantity: -1 })).toThrow("Quantity must be more than zero.");
  removeHolding(db, x.id);
  expect(listHoldings(db, spaceId)).toEqual([]);
  off();
  expect(changed).toBeGreaterThanOrEqual(3);
});

test("replaceImported only replaces those accounts' imported rows", () => {
  addHolding(db, spaceId, h("TFSA", "MANUAL"));
  replaceImported(db, spaceId, "wealthsimple_holdings", ["TFSA", "RRSP"], [h("TFSA", "OLD1"), h("TFSA", "OLD2"), h("RRSP", "KEEP")]);
  const r = replaceImported(db, spaceId, "wealthsimple_activity", ["TFSA"], [h("TFSA", "N1"), h("TFSA", "N2"), h("TFSA", "N3")]);
  expect(r).toEqual({ added: 3, replaced: 2 });
  const rows = listHoldings(db, spaceId);
  expect(rows.map((x) => x.symbol).sort()).toEqual(["KEEP", "MANUAL", "N1", "N2", "N3"]);
  expect(rows.find((x) => x.symbol === "N1")!.source).toBe("wealthsimple_activity");
  expect(rows.find((x) => x.symbol === "MANUAL")!.source).toBe("manual");
});

test("portfolioDay mixes sources", async () => {
  const { setSetting } = await import("../../../src/engine/settings");
  const { saveQuotes } = await import("../../../src/engine/markets/cache");
  const { createMarketData } = await import("../../../src/engine/markets/data");
  const { saveFx } = await import("../../../src/engine/markets/fx");
  const { recordCloses } = await import("../../../src/engine/markets/closes");
  const { portfolioDay, positionsFor } = await import("../../../src/engine/markets/portfolio");
  setSetting(db, "markets.provider", "finnhub");
  const keys: Record<string, string> = { "finnhub.token": "FHTEST12345", "alphavantage.key": "AVTEST12345" };
  const data = createMarketData({ db, keychain: { get: async (a) => keys[a] ?? null, set: async () => {}, remove: async () => {} } });
  await data.refreshKeys(true);
  const at = Date.parse("2026-11-05T16:00:00Z");
  const closeNov4 = Date.parse("2026-11-04T21:00:00Z");
  addHolding(db, spaceId, { account: "TFSA", symbol: "RKLB", exchange: "US", name: "Rocket Lab", quantity: 10, bookValue: 400, currency: "USD" });
  addHolding(db, spaceId, { account: "TFSA", symbol: "SPY", exchange: "US", name: "SPY", quantity: 2, bookValue: 1000, currency: "USD" });
  addHolding(db, spaceId, { account: "TFSA", symbol: "VFV", exchange: "TSX", name: "VFV", quantity: 5, bookValue: 700, currency: "CAD" });
  saveQuotes(db, [
    { key: "RKLB", price: 53, prevClose: 50, at, source: "finnhub", freshness: "live" },
    { key: "SPY", price: 606, prevClose: 600, at, source: "finnhub", freshness: "live" },
    { key: "VFV.TO", price: 151, prevClose: 150, at: closeNov4, source: "alphavantage", freshness: "eod" },
  ]);
  saveFx(db, [{ date: "2026-11-04", rate: 1.4 }]);
  recordCloses(db, "VFV.TO", [{ date: "2026-11-04", close: 151, adjClose: null, source: "alphavantage" }]);
  recordCloses(db, "SPY", [{ date: "2026-11-04", close: 600, adjClose: null, source: "tiingo" }]);
  expect(positionsFor(db, data, spaceId).map((p) => [p.key, p.price?.tone])).toEqual([["RKLB", "live"], ["SPY", "live"], ["VFV.TO", "delayed"]]);
  const d = portfolioDay(db, data, spaceId)!;
  expect(d.mix).toBe("2 real-time · 1 close of Nov 4");
  expect(d.tone).toBe("delayed");
  // (10×3 + 2×6) × 1.40 + 5×1 = 63.8 on 1×(500+1200)×1.40 + 750 = 3130; the VFV estimate (from SPY's live move) isn't used.
  expect(d.dayCad).toBeCloseTo(63.8, 9);
  expect(d.dayPct).toBeCloseTo((63.8 / 3130) * 100, 9);
  expect(d.movers).toEqual([
    { key: "RKLB", dayPct: expect.closeTo(6, 9), tag: null },
    { key: "SPY", dayPct: expect.closeTo(1, 9), tag: null },
    { key: "VFV.TO", dayPct: expect.closeTo((1 / 150) * 100, 9), tag: "close Nov 4" },
  ]);
  const empty = createSpace(db, { name: "Empty", kind: "markets", goal: "g" });
  expect(portfolioDay(db, data, empty.id)).toBeNull();
});
