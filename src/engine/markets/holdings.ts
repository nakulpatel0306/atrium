import type { Database } from "bun:sqlite";
import { bus } from "../events";
import { newId } from "../ids";
import { syncIdeas } from "./ideas";
import { instrumentKey, type Exchange } from "./instrument";

export type HoldingInput = {
  account: string;
  symbol: string;
  exchange: Exchange;
  name: string;
  quantity: number;
  bookValue: number | null;
  // From a Wealthsimple holdings export's "Book Value (CAD)"; null when the source doesn't say.
  bookValueCad?: number | null;
  currency: "CAD" | "USD";
};
export type Holding = HoldingInput & {
  id: string;
  spaceId: string;
  key: string;
  source: "manual" | "wealthsimple_holdings" | "wealthsimple_activity";
  updatedAt: number;
};

type Row = {
  id: string;
  space_id: string;
  account: string;
  symbol: string;
  exchange: Exchange;
  name: string;
  quantity: number;
  book_value: number | null;
  book_value_cad: number | null;
  currency: "CAD" | "USD";
  source: Holding["source"];
  updated_at: number;
};

const toHolding = (r: Row): Holding => ({
  id: r.id,
  spaceId: r.space_id,
  account: r.account,
  symbol: r.symbol,
  exchange: r.exchange,
  key: instrumentKey(r),
  name: r.name,
  quantity: r.quantity,
  bookValue: r.book_value,
  bookValueCad: r.book_value_cad,
  currency: r.currency,
  source: r.source,
  updatedAt: r.updated_at,
});

const checkQuantity = (q: number) => {
  if (!Number.isFinite(q) || q <= 0) throw new Error("Quantity must be more than zero.");
};

export function listHoldings(db: Database, spaceId: string): Holding[] {
  const rows = db.query("SELECT * FROM market_holdings WHERE space_id = ? ORDER BY account, symbol, rowid").all(spaceId) as Row[];
  return rows.map(toHolding);
}

const getHolding = (db: Database, id: string): Holding | null => {
  const row = db.query("SELECT * FROM market_holdings WHERE id = ?").get(id) as Row | null;
  return row ? toHolding(row) : null;
};

function insert(db: Database, spaceId: string, h: HoldingInput, source: Holding["source"]): string {
  checkQuantity(h.quantity);
  const id = newId("hld");
  db.query(
    "INSERT INTO market_holdings (id, space_id, account, symbol, exchange, name, quantity, book_value, book_value_cad, currency, source, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, spaceId, h.account, h.symbol, h.exchange, h.name, h.quantity, h.bookValue, h.bookValueCad ?? null, h.currency, source, Date.now());
  return id;
}

export function addHolding(db: Database, spaceId: string, h: HoldingInput): Holding {
  const id = insert(db, spaceId, h, "manual");
  syncIdeas(db, spaceId);
  bus.emit({ type: "changed" });
  return getHolding(db, id)!;
}

export function updateHolding(db: Database, id: string, patch: Partial<HoldingInput>): Holding {
  const cur = getHolding(db, id);
  if (!cur) throw new Error(`No holding with id ${id}`);
  const next = { ...cur, ...patch };
  checkQuantity(next.quantity);
  db.query(
    "UPDATE market_holdings SET account = ?, symbol = ?, exchange = ?, name = ?, quantity = ?, book_value = ?, currency = ?, updated_at = ? WHERE id = ?",
  ).run(next.account, next.symbol, next.exchange, next.name, next.quantity, next.bookValue, next.currency, Date.now(), id);
  bus.emit({ type: "changed" });
  return getHolding(db, id)!;
}

export function removeHolding(db: Database, id: string): void {
  const spaceId = getHolding(db, id)?.spaceId;
  db.query("DELETE FROM market_holdings WHERE id = ?").run(id);
  if (spaceId) syncIdeas(db, spaceId);
  bus.emit({ type: "changed" });
}

// A re-import of an account replaces whatever an earlier import put there, whichever export it came from.
// Rows Nakul typed in by hand are his and are never touched.
export function replaceImported(
  db: Database,
  spaceId: string,
  source: Holding["source"],
  accounts: string[],
  rows: HoldingInput[],
): { added: number; replaced: number } {
  const result = db.transaction(() => {
    let replaced = 0;
    for (const account of accounts) {
      replaced += db.query("DELETE FROM market_holdings WHERE space_id = ? AND account = ? AND source != 'manual'").run(spaceId, account).changes;
    }
    for (const r of rows) insert(db, spaceId, r, source);
    syncIdeas(db, spaceId);
    return { added: rows.length, replaced };
  })();
  bus.emit({ type: "changed" });
  return result;
}
