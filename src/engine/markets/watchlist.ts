import type { Database } from "bun:sqlite";
import { bus } from "../events";
import { addToList, ensureDefaultList } from "./lists";
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

// A space's watchlist is the union of its lists: each key once, at its first added_at.
export function listWatchlist(db: Database, spaceId: string): WatchItem[] {
  const rows = db
    .query("SELECT symbol, exchange, name, added_at FROM market_watchlist WHERE space_id = ? ORDER BY added_at, rowid")
    .all(spaceId) as Row[];
  const seen = new Set<string>();
  return rows.map(toItem).filter((i) => !seen.has(i.key) && !!seen.add(i.key));
}

// Adding what's already there keeps the original row (and its name). New keys go to the space's first list.
export function addToWatchlist(db: Database, spaceId: string, i: Instrument, name = ""): WatchItem {
  return addToList(db, ensureDefaultList(db, spaceId).id, i, name);
}

export function removeFromWatchlist(db: Database, spaceId: string, key: string): void {
  const i = parseInstrumentKey(key);
  if (!i) return;
  db.query("DELETE FROM market_watchlist WHERE space_id = ? AND symbol = ? AND exchange = ?").run(spaceId, i.symbol, i.exchange);
  bus.emit({ type: "changed" });
}
