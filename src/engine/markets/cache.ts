import type { Database } from "bun:sqlite";
import type { Bar, Freshness, ProviderId, Quote, Timeframe } from "./providers/types";

type QuoteRow = { key: string; price: number; prev_close: number | null; at: number; source: ProviderId; freshness: Freshness };

export function saveQuotes(db: Database, quotes: Quote[]): void {
  const q = db.query(
    `INSERT INTO market_quotes (key, price, prev_close, at, source, freshness, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET price = excluded.price, prev_close = excluded.prev_close, at = excluded.at,
       source = excluded.source, freshness = excluded.freshness, fetched_at = excluded.fetched_at`,
  );
  const fetchedAt = Date.now();
  db.transaction(() => {
    for (const x of quotes) q.run(x.key, x.price, x.prevClose, x.at, x.source, x.freshness, fetchedAt);
  })();
}

export function cachedQuotes(db: Database, keys: string[]): Map<string, Quote> {
  const out = new Map<string, Quote>();
  if (!keys.length) return out;
  const rows = db.query(`SELECT * FROM market_quotes WHERE key IN (${keys.map(() => "?").join(",")})`).all(...keys) as QuoteRow[];
  for (const r of rows) out.set(r.key, { key: r.key, price: r.price, prevClose: r.prev_close, at: r.at, source: r.source, freshness: r.freshness });
  return out;
}

export function saveBars(db: Database, key: string, tf: Timeframe, bars: Bar[]): void {
  const q = db.query("INSERT OR REPLACE INTO market_bars (key, timeframe, t, o, h, l, c, v) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  db.transaction(() => {
    for (const b of bars) q.run(key, tf, b.t, b.o, b.h, b.l, b.c, b.v);
  })();
}

export function cachedBars(db: Database, key: string, tf: Timeframe, fromSec: number): Bar[] {
  return db
    .query("SELECT t, o, h, l, c, v FROM market_bars WHERE key = ? AND timeframe = ? AND t >= ? ORDER BY t")
    .all(key, tf, fromSec) as Bar[];
}
