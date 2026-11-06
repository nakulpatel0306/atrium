import type { Database } from "bun:sqlite";
import { isAdvanced } from "./advanced";
import { cachedBars } from "./cache";
import { etDate, lastCompletedSession } from "./calendar";
import { adjustedCloses, closes } from "./closes";
import { currentQuote, type MarketData } from "./data";
import { EARNINGS_CHECKED, EARNINGS_DAYS_AHEAD } from "./eod";
import { upcomingEarnings } from "./events";
import { latestFx } from "./fx";
import { portfolioHealth } from "./health";
import { listHoldings } from "./holdings";
import { instrumentKey, parseInstrumentKey, type Exchange, type Instrument } from "./instrument";
import { CA_NOT_PRICED, currencyOfKey } from "./labels";
import { listItems, listLists, type WatchList } from "./lists";
import { getMeta } from "./meta";
import { paperState } from "./paper";
import { portfolioDay, positionsFor } from "./portfolio";
import type { Quote } from "./providers/types";
import { latestWriteups, type Writeup } from "./research";
import { closeDayText, priceTag, quoteSourced, type Sourced } from "./sourced";
import { tvSymbol } from "./tradingview";

// The simple investing views. SQLite only: cached quotes, closes, holdings and earnings, never the network.

export const SPARK_DAYS = 30;
const SPARK_FROM_DAYS = 60;
const DAY_MS = 86_400_000;
const NO_PRICE = "No price yet; Atrium checks again during market hours.";

// Atrium's own closes first; until it has two, the daily bars a chart already cached (early days, Demo mode).
export function spark(db: Database, key: string, now: number = Date.now()): number[] {
  const from = now - SPARK_FROM_DAYS * DAY_MS;
  let values = adjustedCloses(closes(db, key, etDate(from))).map((c) => c.close);
  if (values.length < 2) values = cachedBars(db, key, "1Day", Math.floor(from / 1000)).map((b) => b.c);
  values = values.slice(-SPARK_DAYS);
  return values.length < 2 ? [] : values;
}

export type PriceRow = {
  key: string;
  symbol: string;
  exchange: Exchange;
  name: string;
  price: Sourced | null;
  dayPct: number | null;
  spark: number[];
  missing: string | null;
  tv: string;
};

export type PortfolioView = {
  total: Sourced | null;
  dayCad: number | null;
  dayPct: number | null;
  dayLabel: string | null;
  mix: string | null;
  fx: Sourced | null;
  holdings: (PriceRow & { quantity: number; valueCad: number | null; gainCad: number | null; gainCadPct: number | null })[];
  note: Writeup | null;
  empty: boolean;
  // Which holdings the total leaves out, and what would bring them in.
  left: string | null;
};

function priceRow(db: Database, data: MarketData, i: Instrument, name: string, now: number): PriceRow {
  const key = instrumentKey(i);
  const q = currentQuote(db, data, i);
  const meta = getMeta(db, [key]).get(key);
  return {
    key,
    symbol: i.symbol,
    exchange: i.exchange,
    name: name || meta?.name || "",
    price: q ? quoteSourced(q, now) : null,
    dayPct: q?.prevClose ? (q.price / q.prevClose - 1) * 100 : null,
    spark: spark(db, key, now),
    missing: q ? null : (data.reasonFor(i) ?? NO_PRICE),
    tv: tvSymbol(key, meta?.listing ?? null),
  };
}

// The daily note counts while it's about the latest completed session (or today's, written after the close).
function currentNote(db: Database, spaceId: string, now: number): Writeup | null {
  const w = latestWriteups(db, spaceId, { kind: "digest", limit: 1 })[0];
  if (!w) return null;
  return w.forDate === lastCompletedSession(now).date || w.forDate === etDate(now) ? w : null;
}

export function portfolioView(db: Database, data: MarketData, spaceId: string, now: number): PortfolioView {
  const positions = positionsFor(db, data, spaceId, now);
  const fx = latestFx(db);
  const health = portfolioHealth({ positions, fx, lookThrough: new Map(), meta: new Map(), now });
  const day = portfolioDay(db, data, spaceId, now);
  const names = new Map(listHoldings(db, spaceId).map((h) => [h.key, h.name ?? ""]));

  // One row per key, however many accounts hold it.
  const byKey = new Map<string, { quantity: number; valueCad: number | null; gainCad: number | null; costCad: number | null }>();
  for (const p of positions) {
    const pnl = health.pnl.filter((x) => x.key === p.key && x.account === p.account);
    const valueCad = pnl.reduce<number | null>((s, x) => (s === null || x.valueCad === null ? null : s + x.valueCad), 0);
    const gainCad = pnl.reduce<number | null>((s, x) => (s === null || x.gainCad === null ? null : s + x.gainCad), 0);
    const cur = byKey.get(p.key) ?? { quantity: 0, valueCad: 0, gainCad: 0, costCad: 0 };
    const add = (a: number | null, b: number | null) => (a === null || b === null ? null : a + b);
    byKey.set(p.key, {
      quantity: cur.quantity + p.quantity,
      valueCad: add(cur.valueCad, valueCad),
      gainCad: add(cur.gainCad, gainCad),
      costCad: add(cur.costCad, valueCad !== null && gainCad !== null ? valueCad - gainCad : null),
    });
  }
  const holdings = [...byKey.entries()]
    .map(([key, h]) => ({
      ...priceRow(db, data, parseInstrumentKey(key)!, names.get(key) ?? "", now),
      quantity: h.quantity,
      valueCad: h.valueCad,
      gainCad: h.gainCad,
      gainCadPct: h.gainCad !== null && h.costCad ? (h.gainCad / h.costCad) * 100 : null,
    }))
    .map((r) => (r.price ? r : { ...r, valueCad: null, gainCad: null, gainCadPct: null }))
    .sort((a, b) => (b.valueCad ?? -Infinity) - (a.valueCad ?? -Infinity));

  return {
    total: health.totalCad,
    dayCad: day?.dayCad ?? null,
    dayPct: day?.dayPct ?? null,
    dayLabel: day?.dayLabel ?? null,
    mix: day?.mix ?? null,
    fx,
    holdings,
    note: currentNote(db, spaceId, now),
    empty: positions.length === 0,
    left: leftOut(holdings),
  };
}

// Keyed on the reason itself: a Canadian holding with no price yet is waiting for the TSX to open, whether or not
// there's an Alpha Vantage key.
function leftOut(rows: PriceRow[]): string | null {
  const unpriced = rows.filter((r) => !r.price);
  if (!unpriced.length) return null;
  const ca = unpriced.filter((r) => r.missing === CA_NOT_PRICED).length;
  const other = unpriced.length - ca;
  const parts: string[] = [];
  if (ca) parts.push(ca === 1 ? "1 Canadian holding isn't in the total yet. Yahoo Finance prices it during TSX hours (9:30 AM to 4:00 PM ET)." : `${ca} Canadian holdings aren't in the total yet. Yahoo Finance prices them during TSX hours (9:30 AM to 4:00 PM ET).`);
  if (other) parts.push(other === 1 ? "1 holding has no price yet and isn't in the total." : `${other} holdings have no price yet and aren't in the total.`);
  return parts.join(" ");
}

export type ListsView = { lists: (WatchList & { rows: PriceRow[] })[] };

export function listsView(db: Database, data: MarketData, spaceId: string, now: number): ListsView {
  return {
    lists: listLists(db, spaceId).map((l) => ({ ...l, rows: listItems(db, l.id).map((i) => priceRow(db, data, i, i.name, now)) })),
  };
}

export type EarningsRow = { key: string; name: string; date: string; hour: string | null; epsEstimate: number | null; source: "finnhub" | "you"; held: boolean };
// The same window the end-of-day job and catch-up fetch from Finnhub, so the tab shows everything Atrium knows.
export const EARNINGS_DAYS = EARNINGS_DAYS_AHEAD;

export function earningsView(db: Database, spaceId: string, now: number): { rows: EarningsRow[]; source: string; days: number } {
  const held = new Set(listHoldings(db, spaceId).map((h) => h.key));
  const names = new Map<string, string>();
  for (const h of listHoldings(db, spaceId)) if (h.name) names.set(h.key, h.name);
  for (const l of listLists(db, spaceId)) for (const i of listItems(db, l.id)) if (i.name && !names.has(i.key)) names.set(i.key, i.name);
  const keys = [...new Set([...held, ...names.keys(), ...listLists(db, spaceId).flatMap((l) => listItems(db, l.id).map((i) => i.key))])];
  const meta = getMeta(db, keys);
  const rows = upcomingEarnings(db, keys, etDate(now), EARNINGS_DAYS).map((e) => ({
    key: e.key,
    name: names.get(e.key) || meta.get(e.key)?.name || "",
    date: e.date,
    hour: e.hour,
    epsEstimate: e.epsEstimate,
    source: e.source,
    held: held.has(e.key),
  }));
  // The last check counts even when it found no dates; older Finnhub rows say when they were fetched.
  const raw = (db.query("SELECT value FROM settings WHERE key = ?").get(EARNINGS_CHECKED) as { value: string } | null)?.value;
  const fetched = keys.length
    ? (db.query(`SELECT MAX(fetched_at) AS at FROM market_earnings WHERE source = 'finnhub' AND key IN (${keys.map(() => "?").join(",")})`).get(...keys) as { at: number | null }).at
    : null;
  const checked = Math.max(raw ? (JSON.parse(raw) as { at: number }).at : 0, fetched ?? 0) || null;
  const source = checked
    ? `Finnhub earnings calendar · checked ${closeDayText(checked)}`
    : "Not checked yet. Atrium checks Finnhub's calendar after each close and as soon as a Finnhub key is added.";
  return { rows, source, days: EARNINGS_DAYS };
}

export type GlanceView = {
  portfolio: { totalCad: number | null; dayCad: number | null; dayPct: number | null; dayLabel: string | null; mix: string | null } | null;
  lists: { name: string; rows: { key: string; price: number | null; ccy: "CAD" | "USD"; dayPct: number | null; tag: string | null }[] }[];
  earnings: { key: string; date: string; hour: string | null; held: boolean }[];
  advanced: boolean;
  // Today's and total paper P&L, only with Advanced on and some paper trades.
  paper: { dayPnl: number; totalPnl: number } | null;
};


export function glanceView(db: Database, data: MarketData, spaceId: string, now: number): GlanceView {
  const p = portfolioView(db, data, spaceId, now);
  return {
    portfolio: p.empty ? null : { totalCad: p.total?.value ?? null, dayCad: p.dayCad, dayPct: p.dayPct, dayLabel: p.dayLabel, mix: p.mix },
    lists: listsView(db, data, spaceId, now).lists.map((l) => ({
      name: l.name,
      rows: l.rows.map((r) => ({ key: r.key, price: r.price?.value ?? null, ccy: currencyOfKey(r.key), dayPct: r.dayPct, tag: r.price ? priceTag(r.price, now) : null })),
    })),
    earnings: earningsView(db, spaceId, now).rows.map((e) => ({ key: e.key, date: e.date, hour: e.hour, held: e.held })),
    advanced: isAdvanced(db, spaceId),
    paper: isAdvanced(db, spaceId) ? paperGlance(db, data, spaceId, now) : null,
  };
}

function paperGlance(db: Database, data: MarketData, spaceId: string, now: number): GlanceView["paper"] {
  const symbols = db.query("SELECT DISTINCT symbol FROM paper_fills WHERE space_id = ?").all(spaceId) as { symbol: string }[];
  if (!symbols.length) return null;
  const quotes = new Map<string, Quote>();
  for (const { symbol } of symbols) {
    const q = currentQuote(db, data, { symbol, exchange: "US" });
    if (q) quotes.set(symbol, q);
  }
  const p = paperState(db, spaceId, quotes, now);
  return { dayPnl: p.dayPnl, totalPnl: p.totalPnl };
}
