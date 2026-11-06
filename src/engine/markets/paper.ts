import type { Database } from "bun:sqlite";
import { bus, logActivity } from "../events";
import { newId } from "../ids";
import { etDate, etInstant, usSession } from "./calendar";
import { parseInstrumentKey } from "./instrument";
import { money } from "./labels";
import type { ProviderId, Quote } from "./providers/types";

export const DEFAULT_STARTING_CASH = 10_000;
export const QUOTE_MAX_AGE_MS = 900_000;

export type Fill = {
  id: string;
  spaceId: string;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  quoteAt: number;
  source: ProviderId;
  actor: string;
  strategyId: string | null;
  taskId: string | null;
  reasoning: string;
  createdAt: number;
};

export type PaperState = {
  startingCash: number;
  cash: number;
  positions: { symbol: string; qty: number; avgCost: number; last: number | null; marketValue: number | null; unrealized: number | null }[];
  equity: number;
  realized: number;
  totalPnl: number;
  dayPnl: number;
  fills: Fill[];
};

type FillRow = {
  id: string;
  space_id: string;
  symbol: string;
  side: Fill["side"];
  qty: number;
  price: number;
  quote_at: number;
  source: ProviderId;
  actor: string;
  strategy_id: string | null;
  task_id: string | null;
  reasoning: string;
  created_at: number;
};

const toFill = (r: FillRow): Fill => ({
  id: r.id,
  spaceId: r.space_id,
  symbol: r.symbol,
  side: r.side,
  qty: r.qty,
  price: r.price,
  quoteAt: r.quote_at,
  source: r.source,
  actor: r.actor,
  strategyId: r.strategy_id,
  taskId: r.task_id,
  reasoning: r.reasoning,
  createdAt: r.created_at,
});

const EPS = 1e-9;

function account(db: Database, spaceId: string): { startingCash: number; resetAt: number } {
  db.query("INSERT OR IGNORE INTO paper_accounts (space_id, starting_cash, reset_at) VALUES (?, ?, 0)").run(spaceId, DEFAULT_STARTING_CASH);
  const row = db.query("SELECT starting_cash, reset_at FROM paper_accounts WHERE space_id = ?").get(spaceId) as { starting_cash: number; reset_at: number };
  return { startingCash: row.starting_cash, resetAt: row.reset_at };
}

// `now` is the market clock, so fills (stamped with it) and the reset compare on the same clock in demo mode.
export function resetAccount(db: Database, spaceId: string, startingCash: number, now = Date.now()): void {
  db.query(
    "INSERT INTO paper_accounts (space_id, starting_cash, reset_at) VALUES (?, ?, ?) ON CONFLICT(space_id) DO UPDATE SET starting_cash = excluded.starting_cash, reset_at = excluded.reset_at",
  ).run(spaceId, startingCash, now);
  logActivity(db, spaceId, "you", `Reset the paper account to ${money(startingCash, "USD")}`);
}

const fillsSince = (db: Database, spaceId: string, since: number): Fill[] =>
  (db.query("SELECT * FROM paper_fills WHERE space_id = ? AND created_at >= ? ORDER BY created_at, rowid").all(spaceId, since) as FillRow[]).map(toFill);

type Book = { cash: number; realized: number; held: Map<string, { qty: number; cost: number }> };

// Average cost: a sell takes its share of the position's cost basis.
function replay(startingCash: number, fills: Fill[]): Book {
  const book: Book = { cash: startingCash, realized: 0, held: new Map() };
  for (const f of fills) {
    const p = book.held.get(f.symbol) ?? { qty: 0, cost: 0 };
    if (f.side === "buy") {
      book.cash -= f.qty * f.price;
      p.qty += f.qty;
      p.cost += f.qty * f.price;
    } else {
      const avg = p.qty > EPS ? p.cost / p.qty : 0;
      book.cash += f.qty * f.price;
      book.realized += f.qty * (f.price - avg);
      p.qty -= f.qty;
      p.cost = p.qty > EPS ? p.cost - f.qty * avg : 0;
    }
    if (p.qty > EPS) book.held.set(f.symbol, p);
    else book.held.delete(f.symbol);
  }
  return book;
}

const validQty = (q: number) => Number.isFinite(q) && q > 0 && Math.abs(q * 1e4 - Math.round(q * 1e4)) < 1e-6;

export function placePaperOrder(
  db: Database,
  input: { spaceId: string; symbol: string; side: "buy" | "sell"; qty: number; reasoning: string; actor: string; strategyId?: string; taskId?: string },
  quote: Quote | null,
  now: number,
): { ok: true; fill: Fill } | { ok: false; reason: string } {
  const refuse = (reason: string) => ({ ok: false as const, reason });
  if (!validQty(input.qty)) return refuse("Quantity must be more than zero, with at most 4 decimals.");
  const reasoning = input.reasoning.trim();
  if (!reasoning) return refuse("Give a reason for the trade; it's kept with the fill.");
  const inst = parseInstrumentKey(input.symbol);
  if (!inst || inst.exchange !== "US") return refuse("Paper trading covers US stocks only.");
  const symbol = inst.symbol;
  if (!usSession(now).open) return refuse("Paper trades only fill while the US market is open.");
  if (!quote || quote.freshness === "eod") return refuse(`No live price for ${symbol} right now.`);
  if (now - quote.at > QUOTE_MAX_AGE_MS) return refuse(`The last price for ${symbol} is more than 15 minutes old.`);
  const acct = account(db, input.spaceId);
  const book = replay(acct.startingCash, fillsSince(db, input.spaceId, acct.resetAt));
  const cost = input.qty * quote.price;
  if (input.side === "buy" && cost > book.cash + EPS) {
    return refuse(`Not enough paper cash: this needs ${money(cost, "USD")} and you have ${money(book.cash, "USD")}.`);
  }
  const held = book.held.get(symbol)?.qty ?? 0;
  if (input.side === "sell" && input.qty > held + EPS) return refuse(`You can't sell more ${symbol} than the paper account holds (${held}).`);
  const id = newId("fil");
  db.query(
    "INSERT INTO paper_fills (id, space_id, symbol, side, qty, price, quote_at, source, actor, strategy_id, task_id, reasoning, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, input.spaceId, symbol, input.side, input.qty, quote.price, quote.at, quote.source, input.actor, input.strategyId ?? null, input.taskId ?? null, reasoning, now);
  logActivity(db, input.spaceId, input.actor, `Paper ${input.side} ${input.qty} ${symbol} @ ${money(quote.price, "USD")}`);
  bus.emit({ type: "changed" });
  return { ok: true, fill: toFill(db.query("SELECT * FROM paper_fills WHERE id = ?").get(id) as FillRow) };
}

export function paperState(db: Database, spaceId: string, quotes: Map<string, Quote>, now: number): PaperState {
  const acct = account(db, spaceId);
  const fills = fillsSince(db, spaceId, acct.resetAt);
  const book = replay(acct.startingCash, fills);
  const positions = [...book.held.entries()].map(([symbol, p]) => {
    const last = quotes.get(symbol)?.price ?? null;
    const avgCost = p.cost / p.qty;
    return {
      symbol,
      qty: p.qty,
      avgCost,
      last,
      marketValue: last === null ? null : p.qty * last,
      unrealized: last === null ? null : p.qty * (last - avgCost),
    };
  });
  // A position with no price yet is carried at cost rather than as zero.
  const equity = book.cash + positions.reduce((s, p) => s + (p.marketValue ?? p.qty * p.avgCost), 0);
  const midnight = etInstant(etDate(now), "00:00");
  let baseline = acct.startingCash;
  if (acct.resetAt < midnight) {
    const then = replay(acct.startingCash, fills.filter((f) => f.createdAt < midnight));
    baseline = then.cash;
    for (const [symbol, p] of then.held) baseline += p.qty * (quotes.get(symbol)?.prevClose ?? p.cost / p.qty);
  }
  return {
    startingCash: acct.startingCash,
    cash: book.cash,
    positions,
    equity,
    realized: book.realized,
    totalPnl: equity - acct.startingCash,
    dayPnl: equity - baseline,
    fills: [...fills].reverse(),
  };
}
