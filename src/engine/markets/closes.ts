import type { Database } from "bun:sqlite";
import { getSetting } from "../settings";

// Atrium's own daily closes. They grow with every after-close fetch, so history builds up without extra calls.
export type Close = { date: string; close: number; adjClose: number | null; source: string };

// A close from a lower-ranked source never replaces one from a higher-ranked source.
export const CLOSE_RANK = ["tiingo", "alphavantage", "alpaca", "finnhub", "demo"];
const rank = (source: string) => {
  const i = CLOSE_RANK.indexOf(source);
  return i < 0 ? CLOSE_RANK.length : i;
};
const demoMode = (db: Database) => getSetting(db, "markets.provider") === "demo";

export function recordCloses(db: Database, key: string, rows: Close[]): void {
  // Demo prices are made up; outside Demo mode they'd pass for real history.
  const keep = demoMode(db) ? rows : rows.filter((r) => r.source !== "demo");
  if (!keep.length) return;
  const existing = db.query("SELECT source FROM market_closes WHERE key = ? AND date = ?");
  const put = db.query("INSERT OR REPLACE INTO market_closes (key, date, close, adj_close, source) VALUES (?, ?, ?, ?, ?)");
  db.transaction(() => {
    for (const r of keep) {
      const cur = existing.get(key, r.date) as { source: string } | null;
      if (cur && rank(cur.source) < rank(r.source)) continue;
      put.run(key, r.date, r.close, r.adjClose, r.source);
    }
  })();
}

type Row = { date: string; close: number; adj_close: number | null; source: string };
const toClose = (r: Row): Close => ({ date: r.date, close: r.close, adjClose: r.adj_close, source: r.source });
const demoFilter = (db: Database) => (demoMode(db) ? "" : " AND source != 'demo'");

export function closes(db: Database, key: string, fromDate: string): Close[] {
  const rows = db.query(`SELECT date, close, adj_close, source FROM market_closes WHERE key = ? AND date >= ?${demoFilter(db)} ORDER BY date`).all(key, fromDate) as Row[];
  return rows.map(toClose);
}

export function closeOn(db: Database, key: string, date: string): Close | null {
  const r = db.query(`SELECT date, close, adj_close, source FROM market_closes WHERE key = ? AND date = ?${demoFilter(db)}`).get(key, date) as Row | null;
  return r ? toClose(r) : null;
}

export function latestClose(db: Database, key: string): Close | null {
  const r = db.query(`SELECT date, close, adj_close, source FROM market_closes WHERE key = ?${demoFilter(db)} ORDER BY date DESC LIMIT 1`).get(key) as Row | null;
  return r ? toClose(r) : null;
}

export function closeCount(db: Database, key: string): number {
  return (db.query(`SELECT COUNT(*) AS n FROM market_closes WHERE key = ?${demoFilter(db)}`).get(key) as { n: number }).n;
}

// A series safe to compare across time: with any adjusted closes (Tiingo), only those, valued at the adjusted
// close; otherwise the raw closes as stored. Raw and adjusted are never mixed, so a split never shows as a cliff.
export function adjustedCloses(rows: Close[]): Close[] {
  if (!rows.some((r) => r.adjClose !== null)) return rows;
  return rows.filter((r) => r.adjClose !== null).map((r) => ({ ...r, close: r.adjClose! }));
}
