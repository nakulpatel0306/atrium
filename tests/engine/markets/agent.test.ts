import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { listPending, onApprovalResolved, resolveApproval } from "../../../src/engine/approvals";
import { openDb } from "../../../src/engine/db";
import { setSetting } from "../../../src/engine/settings";
import { createSpace, type Space } from "../../../src/engine/spaces";
import { createTask } from "../../../src/engine/tasks";
import { createMarketsHooks, parseMarketsBlock } from "../../../src/engine/markets/agent";
import { saveQuotes } from "../../../src/engine/markets/cache";
import { createMarketData } from "../../../src/engine/markets/data";
import { addHolding } from "../../../src/engine/markets/holdings";
import type { Keychain } from "../../../src/engine/markets/keychain";
import { demoProvider } from "../../../src/engine/markets/providers/demo";
import { handleStrategyDecision, proposeStrategy } from "../../../src/engine/markets/strategies";
import { addToWatchlist } from "../../../src/engine/markets/watchlist";
import { tempHome } from "../../helpers";

let home: ReturnType<typeof tempHome>;
let db: Database;
let space: Space;
let off: () => void;
const NOW = Date.parse("2026-11-05T15:00:00Z");
const keychain: Keychain = { get: async () => null, set: async () => {}, remove: async () => {} };

beforeEach(() => {
  home = tempHome();
  db = openDb();
  space = createSpace(db, { name: "Stocks", kind: "markets", goal: "paper" });
  off = onApprovalResolved((a, d) => handleStrategyDecision(db, a, d));
  setSetting(db, "markets.provider", "demo");
});
afterEach(() => {
  off();
  db.close();
  home.cleanup();
});

const hooks = () => createMarketsHooks(db, { data: createMarketData({ db, keychain, now: () => NOW, providers: { demo: demoProvider({ now: () => NOW }) } }), now: () => NOW });
const block = (json: unknown) => `Here's my read.\n\n\`\`\`atrium-markets\n${JSON.stringify(json)}\n\`\`\`\nAnalysis, not advice.`;

test("parseMarketsBlock takes the last block", () => {
  expect(parseMarketsBlock(`${block({ flags: [] })}\n${block({ orders: [] })}`)).toEqual({ orders: [] });
  expect(parseMarketsBlock("just prose")).toBeNull();
  expect(parseMarketsBlock("```atrium-markets\n{bad json\n```")).toBeNull();
});

test("context: public prices for everyone, account details only for Claude", async () => {
  addToWatchlist(db, space.id, { symbol: "AAPL", exchange: "US" });
  addHolding(db, space.id, { account: "SecretTFSA", symbol: "SHOP", exchange: "TSX", name: "Shopify", quantity: 7, bookValue: 4321.5, currency: "CAD" });
  const task = createTask(db, { spaceId: space.id, title: "Explain" });
  const codex = await hooks().context(task, space, "codex");
  expect(codex).toContain("Market data as of 10:00 AM ET");
  expect(codex).toMatch(/AAPL \$\d+\.\d\d/);
  expect(codex).not.toContain("SecretTFSA");
  expect(codex).not.toContain("4,321.50");
  expect(codex).not.toContain("Paper account");
  const claude = await hooks().context(task, space, "claude");
  expect(claude).toContain("SecretTFSA");
  expect(claude).toContain("CA$4,321.50");
  expect(claude).toContain("Paper account: cash $10,000.00");
  expect(claude).toContain("atrium-markets");
});

function activeStrategy(max = 2000, trades = 3) {
  const s = proposeStrategy(db, space.id, { name: "Momentum", rules: "r", symbols: ["AAPL"], cadence: "open", maxPositionValue: max, maxTradesPerDay: trades }, "claude");
  resolveApproval(db, s.approvalId!, "approve");
  return s;
}

const order = (qty: number, symbol = "AAPL") => ({ symbol, side: "buy", qty, reason: `buy ${qty}` });

test("settle on an active strategy task honours limits", async () => {
  const s = activeStrategy(2000, 3);
  saveQuotes(db, [{ key: "AAPL", price: 100, prevClose: 99, at: NOW, source: "demo", freshness: "demo" }, { key: "MSFT", price: 100, prevClose: 99, at: NOW, source: "demo", freshness: "demo" }]);
  const task = createTask(db, { spaceId: space.id, title: "Paper strategy: Momentum", agent: "claude", strategyId: s.id });
  const r = await hooks().settle(task, space, "claude", block({ orders: [order(5), order(50), order(1, "MSFT"), order(1), order(1), order(1)] }));
  expect(r.done).toBe(true);
  expect(r.lines[0]).toBe("Filled: buy 5 AAPL @ $100.00 — buy 5");
  expect(r.lines[1]).toBe("Refused: buy 50 AAPL — that would put $5,500.00 in AAPL; this strategy's limit is $2,000.00.");
  expect(r.lines[2]).toBe("Refused: buy 1 MSFT — MSFT isn't one of this strategy's symbols.");
  expect(r.lines[3]).toStartWith("Filled: buy 1 AAPL");
  expect(r.lines[4]).toStartWith("Filled: buy 1 AAPL");
  expect(r.lines).toHaveLength(5);
  expect(r.activity).toBe("Paper strategy run: 3 filled, 2 refused");
  const r2 = await hooks().settle(task, space, "claude", block({ orders: [order(1)] }));
  expect(r2.lines[0]).toBe("Refused: buy 1 AAPL — this strategy already made its 3 trades today.");
  const fills = db.query("SELECT reasoning, strategy_id, task_id FROM paper_fills").all() as { reasoning: string; strategy_id: string; task_id: string }[];
  expect(fills).toHaveLength(3);
  for (const f of fills) expect(f).toMatchObject({ strategy_id: s.id, task_id: task.id });
  expect(fills[0]!.reasoning).toBe("buy 5");
  expect((db.query("SELECT last_run_at FROM market_strategies").get() as { last_run_at: number }).last_run_at).toBe(NOW);
});

test("settle on a normal task ignores orders; flags and backtests are capped", async () => {
  saveQuotes(db, [{ key: "AAPL", price: 100, prevClose: 99, at: NOW, source: "demo", freshness: "demo" }]);
  const task = createTask(db, { spaceId: space.id, title: "Look around" });
  const bt = { symbol: "AAPL", template: { kind: "buy_hold" }, range: "3M" };
  const r = await hooks().settle(task, space, "codex", block({ orders: [order(1)], flags: [{ symbol: "aapl", note: "Earnings gap" }], backtests: [bt, bt, bt, bt] }));
  expect(r.done).toBe(false);
  expect(r.lines).toContain("Paper orders only run from an approved strategy; ignored 1.");
  expect(db.query("SELECT COUNT(*) AS n FROM paper_fills").get()).toEqual({ n: 0 });
  const flag = listPending(db).find((a) => a.kind === "alert")!;
  expect(flag.title).toBe("Codex flagged AAPL");
  expect(flag.detail).toBe("Earnings gap\n\nAnalysis, not advice.");
  expect(r.lines.filter((l) => l.startsWith("Backtest AAPL Buy and hold (3M):"))).toHaveLength(3);
});

test("a proposed strategy goes to Needs you", async () => {
  const task = createTask(db, { spaceId: space.id, title: "Design a strategy" });
  const s = { name: "Dip", rules: "Buy dips", symbols: ["SPY"], cadence: "close", maxPositionValue: 1000, maxTradesPerDay: 2 };
  const r = await hooks().settle(task, space, "claude", block({ strategies: [s, { ...s, name: "Second" }] }));
  expect(r.lines).toEqual(['Proposed paper strategy "Dip"; it\'s in Needs you.']);
  expect(listPending(db).map((a) => a.title)).toEqual(["Approve paper strategy: Dip"]);
});
