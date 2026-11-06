import type { Database } from "bun:sqlite";
import { getSetting } from "../settings";
import { cachedQuotes } from "./cache";
import { marketNow } from "./calendar";
import { instrumentKey, type Exchange } from "./instrument";
import { recentNews } from "./events";
import { paperState } from "./paper";
import { portfolioDayFromCache, type PortfolioDay } from "./portfolio";
import type { Freshness } from "./providers/types";

export type MarketsBriefing = {
  paper: { dayPnl: number; totalPnl: number; equity: number } | null;
  // Kept for older clients; Home renders the portfolio line instead.
  holdings: { key: string; dayPct: number; freshness: Freshness; asOf: number }[];
  portfolio: (PortfolioDay & { headline: string | null }) | null;
};

const DAY_MS = 86_400_000;
const HEADLINE_MAX = 60;

// The Investing space when there is one, else the first markets space with holdings.
function portfolioOf(db: Database, now: number): MarketsBriefing["portfolio"] {
  const spaces = db.query("SELECT id, name FROM spaces WHERE kind = 'markets' AND status = 'active' ORDER BY created_at").all() as { id: string; name: string }[];
  const held = (id: string) => !!db.query("SELECT 1 FROM market_holdings WHERE space_id = ? LIMIT 1").get(id);
  const space = spaces.find((s) => s.name === "Investing" && held(s.id)) ?? spaces.find((s) => held(s.id));
  if (!space) return null;
  const day = portfolioDayFromCache(db, space.id, now);
  if (!day) return null;
  const top = day.movers[0];
  const news = top ? recentNews(db, [top.key], now - DAY_MS, 1)[0] : undefined;
  const headline = news ? (news.headline.length > HEADLINE_MAX ? `${news.headline.slice(0, HEADLINE_MAX - 1).trimEnd()}…` : news.headline) : null;
  return { ...day, headline };
}

// Cache only: the briefing renders on every state read and must never touch the network.
export function marketsBriefing(db: Database, wallNow: number): MarketsBriefing | null {
  // Paper fills are stamped with the market clock, which demo mode can shift; "today" must use the same clock.
  const now = wallNow + (marketNow(getSetting(db, "markets.provider") ?? "alpaca") - Date.now());
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
  return { paper, holdings: moves, portfolio: portfolioOf(db, now) };
}
