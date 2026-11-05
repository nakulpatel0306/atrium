import type { Database } from "bun:sqlite";
import { bus } from "../events";
import { instrumentKey, parseInstrumentKey, type Exchange, type Instrument } from "./instrument";

export type WatchItem = Instrument & { key: string; name: string; addedAt: number };

type Row = { symbol: string; exchange: Exchange; name: string; added_at: number };

const toItem = (r: Row): WatchItem => ({
  symbol: r.symbol,
  exchange: r.exchange,
  key: instrumentKey(r),
  name: r.name,
  addedAt: r.added_at,
});

export function listWatchlist(db: Database, spaceId: string): WatchItem[] {
  const rows = db
    .query("SELECT symbol, exchange, name, added_at FROM market_watchlist WHERE space_id = ? ORDER BY added_at, rowid")
    .all(spaceId) as Row[];
  return rows.map(toItem);
}

// Adding what's already there keeps the original row (and its name).
export function addToWatchlist(db: Database, spaceId: string, i: Instrument, name = ""): WatchItem {
  db.query("INSERT OR IGNORE INTO market_watchlist (space_id, symbol, exchange, name, added_at) VALUES (?, ?, ?, ?, ?)").run(
    spaceId,
    i.symbol,
    i.exchange,
    name,
    Date.now(),
  );
  bus.emit({ type: "changed" });
  const row = db
    .query("SELECT symbol, exchange, name, added_at FROM market_watchlist WHERE space_id = ? AND symbol = ? AND exchange = ?")
    .get(spaceId, i.symbol, i.exchange) as Row;
  return toItem(row);
}

export function removeFromWatchlist(db: Database, spaceId: string, key: string): void {
  const i = parseInstrumentKey(key);
  if (!i) return;
  db.query("DELETE FROM market_watchlist WHERE space_id = ? AND symbol = ? AND exchange = ?").run(spaceId, i.symbol, i.exchange);
  bus.emit({ type: "changed" });
}
