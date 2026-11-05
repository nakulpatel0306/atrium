import type { Database } from "bun:sqlite";
import { newId } from "../ids";
import type { MarketData } from "./data";
import { trackedInstruments } from "./feed";
import { isFund } from "./funds/sources";
import { instrumentKey } from "./instrument";
import type { Job } from "./jobs";
import type { EarningsDate, NewsItem } from "./providers/types";

const DAY_MS = 86_400_000;
const KEEP_NEWS_MS = 30 * DAY_MS;
export type Earnings = EarningsDate & { source: "finnhub" | "you" };

const plus = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const marks = (n: number) => Array(n).fill("?").join(",");

// A date Nakul entered for a key is his, and Finnhub never overwrites it. replaceFrom clears Finnhub's older guesses
// for those keys first, so a moved date doesn't leave the old one behind.
export function saveEarnings(db: Database, rows: EarningsDate[], source: "finnhub" | "you", opts: { replaceFrom?: { keys: string[]; from: string } } = {}): void {
  const now = Date.now();
  db.transaction(() => {
    const r = opts.replaceFrom;
    if (source === "finnhub" && r?.keys.length) {
      db.query(`DELETE FROM market_earnings WHERE source = 'finnhub' AND date >= ? AND key IN (${marks(r.keys.length)})`).run(r.from, ...r.keys);
    }
    const mine = db.query("SELECT 1 FROM market_earnings WHERE key = ? AND source = 'you' LIMIT 1");
    const put = db.query("INSERT OR REPLACE INTO market_earnings (key, date, hour, eps_estimate, source, fetched_at) VALUES (?, ?, ?, ?, ?, ?)");
    for (const e of rows) {
      if (source === "finnhub" && mine.get(e.key)) continue;
      put.run(e.key, e.date, e.hour, e.epsEstimate, source, now);
    }
  })();
}

export function upcomingEarnings(db: Database, keys: string[], fromDate: string, days: number): Earnings[] {
  if (!keys.length) return [];
  const rows = db
    .query(`SELECT key, date, hour, eps_estimate, source FROM market_earnings WHERE key IN (${marks(keys.length)}) AND date >= ? AND date <= ? ORDER BY date, key`)
    .all(...keys, fromDate, plus(fromDate, days)) as { key: string; date: string; hour: string | null; eps_estimate: number | null; source: Earnings["source"] }[];
  return rows.map((r) => ({ key: r.key, date: r.date, hour: r.hour, epsEstimate: r.eps_estimate, source: r.source }));
}

export function saveNews(db: Database, items: NewsItem[], now: number = Date.now()): void {
  const put = db.query("INSERT OR IGNORE INTO market_news (id, key, headline, source, url, at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  db.transaction(() => {
    for (const n of items) if (n.url && n.headline) put.run(newId("nws"), n.key, n.headline, n.source, n.url, n.at, now);
    db.query("DELETE FROM market_news WHERE at < ?").run(now - KEEP_NEWS_MS);
  })();
}

export function recentNews(db: Database, keys: string[], sinceMs: number, limit: number): NewsItem[] {
  if (!keys.length) return [];
  return db
    .query(`SELECT key, headline, source, url, at FROM market_news WHERE key IN (${marks(keys.length)}) AND at >= ? ORDER BY at DESC LIMIT ?`)
    .all(...keys, sinceMs, limit) as NewsItem[];
}

// Company news for tracked stocks (funds have none worth reading), from the newest stored item, at most a day back.
export async function fetchNews(db: Database, data: MarketData, now: number): Promise<number> {
  const list = trackedInstruments(db).filter((i) => !isFund(instrumentKey(i)));
  if (!list.length) return 0;
  const keys = list.map(instrumentKey);
  const newest = (db.query(`SELECT MAX(at) AS at FROM market_news WHERE key IN (${marks(keys.length)})`).get(...keys) as { at: number | null }).at;
  const since = Math.max(newest ?? 0, now - DAY_MS);
  const items = await data.news(list, since);
  saveNews(db, items, now);
  return items.length;
}

export function newsJob(db: Database, deps: { data: MarketData; now: () => number }): Job {
  return {
    name: "news",
    slot: { everyMinutes: 60, from: "10:00", to: "16:00", days: "weekdays" },
    async run(now) {
      await fetchNews(db, deps.data, now);
    },
  };
}
