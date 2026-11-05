import type { Database } from "bun:sqlite";
import { cachedQuotes } from "./cache";
import { instrumentKey, type Exchange } from "./instrument";
import { paperState } from "./paper";
import type { Freshness } from "./providers/types";

export type MarketsBriefing = {
  paper: { dayPnl: number; totalPnl: number; equity: number } | null;
  holdings: { key: string; dayPct: number; freshness: Freshness; asOf: number }[];
};

// Cache only: the briefing renders on every state read and must never touch the network.
export function marketsBriefing(db: Database, now: number): MarketsBriefing | null {
  const spaces = db.query("SELECT id FROM spaces WHERE kind = 'markets' AND status = 'active'").all() as { id: string }[];
  if (!spaces.length) return null;
  const ids = spaces.map((s) => s.id);
  const marks = ids.map(() => "?").join(",");
  const holdings = db.query(`SELECT DISTINCT symbol, exchange FROM market_holdings WHERE space_id IN (${marks})`).all(...ids) as { symbol: string; exchange: Exchange }[];
  const traded = db
    .query(`SELECT DISTINCT f.space_id AS space_id, f.symbol AS symbol FROM paper_fills f WHERE f.space_id IN (${marks})`)
    .all(...ids) as { space_id: string; symbol: string }[];
  const keys = [...new Set([...holdings.map(instrumentKey), ...traded.map((t) => t.symbol)])];
  const quotes = cachedQuotes(db, keys);

  let paper: MarketsBriefing["paper"] = null;
  for (const id of new Set(traded.map((t) => t.space_id))) {
    const s = paperState(db, id, quotes, now);
    if (!s.fills.length) continue;
    paper ??= { dayPnl: 0, totalPnl: 0, equity: 0 };
    paper.dayPnl += s.dayPnl;
    paper.totalPnl += s.totalPnl;
    paper.equity += s.equity;
  }

  const moves = holdings
    .map((h) => quotes.get(instrumentKey(h)))
    .filter((q) => q !== undefined && q.prevClose)
    .map((q) => ({ key: q!.key, dayPct: (q!.price / q!.prevClose! - 1) * 100, freshness: q!.freshness, asOf: q!.at }))
    .sort((a, b) => Math.abs(b.dayPct) - Math.abs(a.dayPct))
    .slice(0, 5);
  return { paper, holdings: moves };
}
