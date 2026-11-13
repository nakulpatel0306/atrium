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
  expect(codex).not.toContain("SHOP");
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
  expect(r.lines[0]).toBe("Filled: buy 5 AAPL @ $100.00 · buy 5");
  expect(r.lines[1]).toBe("Refused: buy 50 AAPL · that would put $5,500.00 in AAPL; this strategy's limit is $2,000.00.");
  expect(r.lines[2]).toBe("Refused: buy 1 MSFT · MSFT isn't one of this strategy's symbols.");
  expect(r.lines[3]).toStartWith("Filled: buy 1 AAPL");
  expect(r.lines[4]).toStartWith("Filled: buy 1 AAPL");
  expect(r.lines).toHaveLength(5);
  expect(r.activity).toBe("Paper strategy run: 3 filled, 2 refused");
  const r2 = await hooks().settle(task, space, "claude", block({ orders: [order(1)] }));
  expect(r2.lines[0]).toBe("Refused: buy 1 AAPL · this strategy already made its 3 trades today.");
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

test("a strategy never fills from a price the current provider didn't give", async () => {
  const s = activeStrategy(2000, 3);
  // A real-looking price left in the cache from before switching to Demo.
  saveQuotes(db, [{ key: "AAPL", price: 100, prevClose: 99, at: NOW, source: "alpaca", freshness: "live" }]);
  const task = createTask(db, { spaceId: space.id, title: "Paper strategy: Momentum", agent: "claude", strategyId: s.id });
  const r = await hooks().settle(task, space, "claude", block({ orders: [order(1)] }));
  expect(r.lines).toEqual(["Refused: buy 1 AAPL · No live price for AAPL right now."]);
});

test("an investing digest gets the portfolio and the news, for Claude only", async () => {
  const { saveNews } = await import("../../../src/engine/markets/events");
  addHolding(db, space.id, { account: "TFSA", symbol: "RKLB", exchange: "US", name: "Rocket Lab", quantity: 10, bookValue: 400, currency: "USD" });
  saveNews(db, [{ key: "RKLB", headline: "Rocket Lab wins NASA contract", source: "Reuters", url: "https://x/1", at: NOW - 3_600_000 }], NOW);
  const { saveFx } = await import("../../../src/engine/markets/fx");
  saveFx(db, [{ date: "2026-11-04", rate: 1.4 }]);
  const task = createTask(db, { spaceId: space.id, title: "Daily digest: what moved and why", agent: "claude", purpose: "digest" });
  const claude = await hooks().context(task, space, "claude");
  expect(claude).toContain("Portfolio: CA$");
  expect(claude).toContain("Rocket Lab wins NASA contract");
  const codex = await hooks().context(task, space, "codex");
  expect(codex).not.toContain("Portfolio: CA$");
  expect(codex).not.toContain("RKLB");
});

test("a thesis draft gets the subject's facts and the no-advice line", async () => {
  const { saveNotes } = await import("../../../src/engine/markets/research");
  addToWatchlist(db, space.id, { symbol: "NOW", exchange: "US" });
  saveNotes(db, space.id, "NOW", { thesis: "Secret thesis", notes: "Secret notes" });
  const draft = createTask(db, { spaceId: space.id, title: "Draft a thesis for NOW", agent: "claude", purpose: "thesis_draft", subject: "NOW" });
  const text = await hooks().context(draft, space, "claude");
  expect(text).toContain("Write plain prose for the user. Do not recommend buying or selling.");
  expect(text).toContain("About NOW:");
  expect(text).not.toContain("Secret thesis");
  const check = createTask(db, { spaceId: space.id, title: "Thesis check before NOW earnings on 2026-11-06", agent: "claude", purpose: "thesis_check", subject: "NOW" });
  expect(await hooks().context(check, space, "claude")).toContain("Secret thesis");
});

test("settling a digest stores it as a write-up instead of asking for review", async () => {
  const { latestWriteups } = await import("../../../src/engine/markets/research");
  const task = createTask(db, { spaceId: space.id, title: "Daily digest: what moved and why", agent: "claude", purpose: "digest" });
  const r = await hooks().settle(task, space, "claude", `RKLB rose on a NASA contract.\n\n\`\`\`atrium-markets\n${JSON.stringify({ flags: [{ symbol: "RKLB", note: "Watch the backlog" }] })}\n\`\`\``);
  expect(r).toEqual({ done: true, lines: ["Flagged RKLB: Watch the backlog"], activity: "Digest saved" });
  const w = latestWriteups(db, space.id, { kind: "digest" })[0]!;
  expect(w.body).toBe("RKLB rose on a NASA contract.\n\nAnalysis, not advice.");
  expect(w).toMatchObject({ key: null, forDate: "2026-11-05", taskId: task.id });
  const check = createTask(db, { spaceId: space.id, title: "Thesis check before NOW earnings on 2026-11-06", agent: "claude", purpose: "thesis_check", subject: "NOW" });
  await hooks().settle(check, space, "claude", "Still holds.\n\nAnalysis, not advice.");
  expect(latestWriteups(db, space.id, { kind: "thesis_check", key: "NOW" })[0]).toMatchObject({ forDate: "2026-11-06", body: "Still holds.\n\nAnalysis, not advice." });
});

test("with the market closed, moves are dated by their session, not called today", async () => {
  const SATURDAY = Date.parse("2026-11-07T17:00:00Z");
  const FRIDAY_CLOSE = Date.parse("2026-11-06T21:00:00Z");
  addToWatchlist(db, space.id, { symbol: "AAPL", exchange: "US" });
  saveQuotes(db, [{ key: "AAPL", price: 101, prevClose: 100, at: FRIDAY_CLOSE, source: "demo", freshness: "demo" }]);
  const closed = createMarketsHooks(db, { data: createMarketData({ db, keychain, now: () => SATURDAY, providers: { demo: demoProvider({ now: () => SATURDAY }) } }), now: () => SATURDAY });
  const digest = createTask(db, { spaceId: space.id, title: "Digest", purpose: "digest" });
  const text = await closed.context(digest, space, "claude");
  expect(text).toContain("AAPL $101.00 +1.00% on Fri, Nov 6");
  expect(text).not.toMatch(/AAPL[^\n]*today/);
  expect(text).toContain("what moved in their portfolio on Fri, Nov 6 and why");
  // During a session it is still "today".
  saveQuotes(db, [{ key: "AAPL", price: 101, prevClose: 100, at: NOW - 60_000, source: "demo", freshness: "demo" }]);
  expect(await hooks().context(digest, space, "claude")).toMatch(/AAPL \$[\d.]+ [+−-][\d.]+% today/);
});

test("ask context has facts, notes, the position line and the question", async () => {
  const { saveNotes } = await import("../../../src/engine/markets/research");
  const { saveFx } = await import("../../../src/engine/markets/fx");
  saveFx(db, [{ date: "2026-11-04", rate: 1.4 }]);
  addHolding(db, space.id, { account: "TFSA", symbol: "AMZN", exchange: "US", name: "Amazon", quantity: 10, bookValue: 1500, currency: "USD" });
  saveNotes(db, space.id, "AMZN", { notes: "Cloud margins matter." });
  const task = createTask(db, { spaceId: space.id, title: "Ask Claude about AMZN", detail: "Why up today?", agent: "claude", purpose: "ask", subject: "AMZN" });
  const text = await hooks().context(task, space, "claude");
  expect(text).toContain("About AMZN:");
  expect(text).toContain("The user's notes: Cloud margins matter.");
  expect(text).toMatch(/The user holds 10 in TFSA, worth CA\$[\d,]+\.\d\d \(.+\), gain [+−]CA\$[\d,]+\.\d\d since purchase\./);
  expect(text).toContain("The user asks: Why up today?");
  expect(text).toContain("Answer in at most 200 words of plain markdown: what the company or fund does, what moved it lately and why, and what to watch next. Don't recommend buying or selling.");
});

test("a non-Claude agent never gets the position line", async () => {
  addHolding(db, space.id, { account: "TFSA", symbol: "AMZN", exchange: "US", name: "Amazon", quantity: 17, bookValue: 1500, currency: "USD" });
  const task = createTask(db, { spaceId: space.id, title: "Ask Claude about AMZN", detail: "", agent: "claude", purpose: "ask", subject: "AMZN" });
  const codex = await hooks().context(task, space, "codex");
  expect(codex).not.toContain("The user holds");
  expect(codex).not.toContain("× 17");
  expect(codex).not.toContain("TFSA");
});

test("ask settles into a kept writeup ending with Analysis, not advice.", async () => {
  const { latestWriteups } = await import("../../../src/engine/markets/research");
  const a = createTask(db, { spaceId: space.id, title: "Ask Claude about AMZN", detail: "One", agent: "claude", purpose: "ask", subject: "AMZN" });
  expect(await hooks().settle(a, space, "claude", "AWS grew.")).toEqual({ done: true, lines: [], activity: "Answer saved" });
  const b = createTask(db, { spaceId: space.id, title: "Ask Claude about AMZN", detail: "Two", agent: "claude", purpose: "ask", subject: "AMZN" });
  await hooks().settle(b, space, "claude", "Retail was flat.\n\nAnalysis, not advice.");
  const asks = latestWriteups(db, space.id, { kind: "ask", key: "AMZN" });
  expect(asks).toHaveLength(2);
  expect(asks.map((w) => w.body).sort()).toEqual(["AWS grew.\n\nAnalysis, not advice.", "Retail was flat.\n\nAnalysis, not advice."]);
});

test("the digest asks for 4 sentences while Advanced is off", async () => {
  const task = createTask(db, { spaceId: space.id, title: "Daily digest: what moved and why", agent: "claude", purpose: "digest" });
  const off = await hooks().context(task, space, "claude");
  expect(off).toContain("Write at most 4 short sentences for the user: what moved in their portfolio today and why, from these prices and headlines. Say which numbers are delayed. No headings.");
  const { setAdvanced } = await import("../../../src/engine/markets/advanced");
  setAdvanced(db, space.id, true);
  expect(await hooks().context(task, space, "claude")).toContain("Write a short digest for the user: what moved in their portfolio today and why");
});

test("news fetched for a Claude task is kept for the daily note and asks", async () => {
  const { recentNews } = await import("../../../src/engine/markets/events");
  addToWatchlist(db, space.id, { symbol: "AAPL", exchange: "US" });
  const data = createMarketData({ db, keychain, now: () => NOW, providers: { demo: demoProvider({ now: () => NOW }) } });
  data.news = async () => [{ key: "AAPL", headline: "Apple ships a thing", source: "Reuters", url: "https://example.com/a", at: NOW - 60_000 }];
  const task = createTask(db, { spaceId: space.id, title: "Daily digest: what moved and why", agent: "claude", purpose: "digest" });
  const text = await createMarketsHooks(db, { data, now: () => NOW }).context(task, space, "claude");
  expect(text).toContain("Apple ships a thing");
  expect(recentNews(db, ["AAPL"], 0, 5).map((n) => n.headline)).toEqual(["Apple ships a thing"]);
});
