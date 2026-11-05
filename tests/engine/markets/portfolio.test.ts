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
