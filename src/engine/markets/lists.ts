import type { Database } from "bun:sqlite";
import { bus } from "../events";
import { newId } from "../ids";
import { instrumentKey, parseInstrumentKey, type Exchange, type Instrument } from "./instrument";
import type { WatchItem } from "./watchlist";

export type WatchList = { id: string; spaceId: string; name: string; position: number; createdAt: number };

export const DEFAULT_LIST_NAME = "Holdings";
export const MAX_LISTS = 20;
const MAX_NAME = 40;

type ListRow = { id: string; space_id: string; name: string; position: number; created_at: number };
type ItemRow = { symbol: string; exchange: Exchange; name: string; added_at: number };

const toList = (r: ListRow): WatchList => ({ id: r.id, spaceId: r.space_id, name: r.name, position: r.position, createdAt: r.created_at });
const toItem = (r: ItemRow): WatchItem => ({ symbol: r.symbol, exchange: r.exchange, key: instrumentKey(r), name: r.name, addedAt: r.added_at });

export function listLists(db: Database, spaceId: string): WatchList[] {
  return (db.query("SELECT * FROM market_lists WHERE space_id = ? ORDER BY position, created_at, rowid").all(spaceId) as ListRow[]).map(toList);
}

export function getList(db: Database, listId: string): WatchList | null {
  const r = db.query("SELECT * FROM market_lists WHERE id = ?").get(listId) as ListRow | null;
  return r ? toList(r) : null;
}

function cleanName(db: Database, spaceId: string, raw: string, except?: string): string {
  const name = raw.trim();
  if (!name) throw new Error("Name the list, like Holdings or Ideas.");
  if (name.length > MAX_NAME) throw new Error("Keep list names under 40 characters.");
  const clash = listLists(db, spaceId).some((l) => l.id !== except && l.name.toLowerCase() === name.toLowerCase());
  if (clash) throw new Error(`You already have a list called "${name}".`);
  return name;
}

function insertList(db: Database, spaceId: string, name: string): WatchList {
  const id = newId("lst");
  const position = ((db.query("SELECT MAX(position) AS p FROM market_lists WHERE space_id = ?").get(spaceId) as { p: number | null }).p ?? -1) + 1;
  db.query("INSERT INTO market_lists (id, space_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)").run(id, spaceId, name, position, Date.now());
  return getList(db, id)!;
}

export function ensureDefaultList(db: Database, spaceId: string): WatchList {
  return listLists(db, spaceId)[0] ?? insertList(db, spaceId, DEFAULT_LIST_NAME);
}

export function createList(db: Database, spaceId: string, raw: string): WatchList {
  const name = cleanName(db, spaceId, raw);
  if (listLists(db, spaceId).length >= MAX_LISTS) throw new Error("That's 20 lists, the most Atrium keeps. Delete one first.");
  const list = insertList(db, spaceId, name);
  bus.emit({ type: "changed" });
  return list;
}

export function renameList(db: Database, listId: string, raw: string): WatchList {
  const list = getList(db, listId);
  if (!list) throw new Error("No such list in this space.");
  const name = cleanName(db, list.spaceId, raw, listId);
  db.query("UPDATE market_lists SET name = ? WHERE id = ?").run(name, listId);
  bus.emit({ type: "changed" });
  return { ...list, name };
}

export function deleteList(db: Database, listId: string): void {
  const list = getList(db, listId);
  if (!list) return;
  if (listLists(db, list.spaceId).length <= 1) throw new Error("Keep at least one list. Make a new one before deleting this.");
  db.transaction(() => {
    db.query("DELETE FROM market_watchlist WHERE list_id = ?").run(listId);
    db.query("DELETE FROM market_lists WHERE id = ?").run(listId);
  })();
  bus.emit({ type: "changed" });
}

export function listItems(db: Database, listId: string): WatchItem[] {
  return (db.query("SELECT symbol, exchange, name, added_at FROM market_watchlist WHERE list_id = ? ORDER BY added_at, rowid").all(listId) as ItemRow[]).map(toItem);
}

// Adding what's already there keeps the original row (and its name).
export function addToList(db: Database, listId: string, i: Instrument, name = ""): WatchItem {
  const list = getList(db, listId);
  if (!list) throw new Error("No such list in this space.");
  db.query("INSERT OR IGNORE INTO market_watchlist (list_id, space_id, symbol, exchange, name, added_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    listId,
    list.spaceId,
    i.symbol,
    i.exchange,
    name,
    Date.now(),
  );
  bus.emit({ type: "changed" });
  return toItem(
    db.query("SELECT symbol, exchange, name, added_at FROM market_watchlist WHERE list_id = ? AND symbol = ? AND exchange = ?").get(listId, i.symbol, i.exchange) as ItemRow,
  );
}

export function removeFromList(db: Database, listId: string, key: string): void {
  const i = parseInstrumentKey(key);
  if (!i) return;
  db.query("DELETE FROM market_watchlist WHERE list_id = ? AND symbol = ? AND exchange = ?").run(listId, i.symbol, i.exchange);
  bus.emit({ type: "changed" });
}

const WATCHLIST_DDL = (name: string) => `CREATE TABLE ${name} (
  list_id TEXT NOT NULL REFERENCES market_lists(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  symbol TEXT NOT NULL,
  exchange TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  added_at INTEGER NOT NULL,
  PRIMARY KEY (list_id, symbol, exchange)
)`;

// Plan 7 kept one watchlist per space. Each space with rows gets a Holdings list holding exactly those rows,
// in one transaction with foreign keys off (SQLite's table-rebuild recipe), checked for new dangling references.
export function migrateWatchlists(db: Database): void {
  const cols = (db.query("PRAGMA table_info(market_watchlist)").all() as { name: string }[]).map((c) => c.name);
  if (cols.includes("list_id")) return;
  const before = db.query("PRAGMA foreign_key_check").all().length;
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec(WATCHLIST_DDL("market_watchlist_new"));
      const spaces = db.query("SELECT DISTINCT space_id FROM market_watchlist ORDER BY space_id").all() as { space_id: string }[];
      const at = Date.now();
      for (const { space_id } of spaces) {
        const id = newId("lst");
        db.query("INSERT INTO market_lists (id, space_id, name, position, created_at) VALUES (?, ?, ?, 0, ?)").run(id, space_id, DEFAULT_LIST_NAME, at);
        db.query(
          `INSERT INTO market_watchlist_new (list_id, space_id, symbol, exchange, name, added_at)
           SELECT ?, space_id, symbol, exchange, name, added_at FROM market_watchlist WHERE space_id = ? ORDER BY added_at, rowid`,
        ).run(id, space_id);
      }
      db.exec("DROP TABLE market_watchlist");
      db.exec("ALTER TABLE market_watchlist_new RENAME TO market_watchlist");
      db.exec("CREATE INDEX IF NOT EXISTS market_watchlist_space ON market_watchlist(space_id)");
    })();
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
  const after = db.query("PRAGMA foreign_key_check").all().length;
  if (after > before) throw new Error(`Moving the watchlist into lists left ${after - before} broken references.`);
}
