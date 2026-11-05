import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../../src/engine/db";
import { createSpace } from "../../../src/engine/spaces";
import { DEFAULT_STARTING_CASH, paperState, placePaperOrder, resetAccount } from "../../../src/engine/markets/paper";
import type { Quote } from "../../../src/engine/markets/providers/types";
import { tempHome } from "../../helpers";

let home: ReturnType<typeof tempHome>;
let db: Database;
let spaceId: string;
const NOW = Date.parse("2026-11-05T15:00:00Z"); // Thu 10:00 ET
const YESTERDAY = Date.parse("2026-11-04T15:00:00Z");

beforeEach(() => {
  home = tempHome();
  db = openDb();
  spaceId = createSpace(db, { name: "Stocks", kind: "markets", goal: "paper" }).id;
});
afterEach(() => {
  db.close();
  home.cleanup();
});

const quote = (symbol: string, price: number, at = NOW, extra: Partial<Quote> = {}): Quote => ({ key: symbol, price, prevClose: null, at, source: "alpaca", freshness: "live", ...extra });
const order = (side: "buy" | "sell", qty: number, symbol = "AAPL", reasoning = "test") => ({ spaceId, symbol, side, qty, reasoning, actor: "you" });

test("average cost: buy 10 @ 100, sell 4 @ 110", () => {
  expect(placePaperOrder(db, order("buy", 10), quote("AAPL", 100), NOW).ok).toBe(true);
  const sell = placePaperOrder(db, order("sell", 4), quote("AAPL", 110), NOW);
  expect(sell.ok).toBe(true);
  const s = paperState(db, spaceId, new Map([["AAPL", quote("AAPL", 110)]]), NOW);
  expect(s.startingCash).toBe(DEFAULT_STARTING_CASH);
  expect(s.cash).toBeCloseTo(9_440, 6);
  expect(s.positions).toEqual([{ symbol: "AAPL", qty: 6, avgCost: 100, last: 110, marketValue: 660, unrealized: 60 }]);
  expect(s.realized).toBeCloseTo(40, 6);
  expect(s.equity).toBeCloseTo(10_100, 6);
  expect(s.totalPnl).toBeCloseTo(100, 6);
  expect(s.fills.map((f) => f.side)).toEqual(["sell", "buy"]);
  expect(s.fills[0]).toMatchObject({ symbol: "AAPL", qty: 4, price: 110, source: "alpaca", actor: "you", reasoning: "test", strategyId: null, taskId: null });
});

test("every refusal", () => {
  const no = (r: ReturnType<typeof placePaperOrder>) => (r.ok ? "filled" : r.reason);
  expect(no(placePaperOrder(db, order("buy", 1), quote("AAPL", 100, Date.parse("2026-11-07T15:00:00Z")), Date.parse("2026-11-07T15:00:00Z")))).toBe(
    "Paper trades only fill while the US market is open.",
  );
  expect(no(placePaperOrder(db, order("buy", 1, "SHOP.TO"), quote("SHOP.TO", 100), NOW))).toBe("Paper trading covers US stocks only; Canadian prices here are end-of-day.");
  expect(no(placePaperOrder(db, order("buy", 1), null, NOW))).toBe("No live price for AAPL right now.");
  expect(no(placePaperOrder(db, order("buy", 1), quote("AAPL", 100, NOW - 16 * 60_000), NOW))).toBe("The last price for AAPL is more than 15 minutes old.");
  expect(no(placePaperOrder(db, order("buy", 200), quote("AAPL", 100), NOW))).toBe("Not enough paper cash: this needs $20,000.00 and you have $10,000.00.");
  expect(no(placePaperOrder(db, order("sell", 1), quote("AAPL", 100), NOW))).toBe("You can't sell more AAPL than the paper account holds (0).");
  expect(no(placePaperOrder(db, order("buy", 0.00001), quote("AAPL", 100), NOW))).toBe("Quantity must be more than zero, with at most 4 decimals.");
  expect(no(placePaperOrder(db, order("buy", 0), quote("AAPL", 100), NOW))).toBe("Quantity must be more than zero, with at most 4 decimals.");
  expect(no(placePaperOrder(db, order("buy", 1, "AAPL", "  "), quote("AAPL", 100), NOW))).toBe("Give a reason for the trade; it's kept with the fill.");
  expect(no(placePaperOrder(db, order("buy", 1), quote("AAPL", 100, NOW, { freshness: "eod" }), NOW))).toBe("No live price for AAPL right now.");
});

test("a demo quote fills with source demo", () => {
  const r = placePaperOrder(db, order("buy", 1.5), quote("AAPL", 100, NOW, { source: "demo", freshness: "demo" }), NOW);
  expect(r.ok && r.fill.source).toBe("demo");
});

test("dayPnl from the previous close, and from starting cash after a reset", () => {
  placePaperOrder(db, order("buy", 10), quote("AAPL", 95, YESTERDAY), YESTERDAY);
  placePaperOrder(db, order("buy", 5), quote("AAPL", 102), NOW);
  const quotes = new Map([["AAPL", quote("AAPL", 103, NOW, { prevClose: 100 })]]);
  expect(paperState(db, spaceId, quotes, NOW).dayPnl).toBeCloseTo(35, 6);
  resetAccount(db, spaceId, 5_000, NOW + 1_000);
  placePaperOrder(db, order("buy", 10), quote("AAPL", 100), NOW + 2_000);
  const s = paperState(db, spaceId, quotes, NOW + 3_000);
  expect(s.startingCash).toBe(5_000);
  expect(s.positions).toHaveLength(1);
  expect(s.dayPnl).toBeCloseTo(30, 6);
});
