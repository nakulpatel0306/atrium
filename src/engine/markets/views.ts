import type { Database } from "bun:sqlite";
import { isAdvanced } from "./advanced";
import { etDate, lastCompletedSession } from "./calendar";
import { adjustedCloses, closes } from "./closes";
import { currentQuote, type MarketData } from "./data";
import { upcomingEarnings } from "./events";
import { latestFx } from "./fx";
import { portfolioHealth } from "./health";
import { listHoldings } from "./holdings";
import { instrumentKey, parseInstrumentKey, type Exchange, type Instrument } from "./instrument";
import { currencyOfKey } from "./labels";
import { listItems, listLists, type WatchList } from "./lists";
import { getMeta } from "./meta";
import { portfolioDay, positionsFor } from "./portfolio";
import { latestWriteups, type Writeup } from "./research";
import { closeDayText, quoteSourced, type Sourced } from "./sourced";
import { tvSymbol } from "./tradingview";

// The simple investing views. SQLite only: cached quotes, closes, holdings and earnings, never the network.

export const SPARK_DAYS = 30;
const SPARK_FROM_DAYS = 60;
const DAY_MS = 86_400_000;
const NO_PRICE = "No price yet; Atrium checks again during market hours.";

export function spark(db: Database, key: string, now: number = Date.now()): number[] {
  const from = etDate(now - SPARK_FROM_DAYS * DAY_MS);
  const values = adjustedCloses(closes(db, key, from))
    .slice(-SPARK_DAYS)
    .map((c) => c.close);
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
  };
}

export type ListsView = { lists: (WatchList & { rows: PriceRow[] })[] };

export function listsView(db: Database, data: MarketData, spaceId: string, now: number): ListsView {
  return {
    lists: listLists(db, spaceId).map((l) => ({ ...l, rows: listItems(db, l.id).map((i) => priceRow(db, data, i, i.name, now)) })),
  };
}

export type EarningsRow = { key: string; name: string; date: string; hour: string | null; epsEstimate: number | null; source: "finnhub" | "you"; held: boolean };
export const EARNINGS_DAYS = 14;

export function earningsView(db: Database, spaceId: string, now: number): { rows: EarningsRow[]; source: string } {
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
  const checked = keys.length
    ? (db.query(`SELECT MAX(fetched_at) AS at FROM market_earnings WHERE source = 'finnhub' AND key IN (${keys.map(() => "?").join(",")})`).get(...keys) as { at: number | null }).at
    : null;
  const source = checked ? `Finnhub earnings calendar · checked ${closeDayText(checked)}` : "No earnings dates yet. Atrium checks Finnhub after each close.";
  return { rows, source };
}

export type GlanceView = {
  portfolio: { totalCad: number | null; dayCad: number | null; dayPct: number | null; dayLabel: string | null; mix: string | null } | null;
  lists: { name: string; rows: { key: string; price: number | null; ccy: "CAD" | "USD"; dayPct: number | null; tag: string | null }[] }[];
  earnings: { key: string; date: string; hour: string | null; held: boolean }[];
  advanced: boolean;
};

const tagOf = (p: Sourced | null): string | null => (!p || p.tone === "live" ? null : p.tone === "demo" ? "demo" : `close ${closeDayText(p.asOf)}`);

export function glanceView(db: Database, data: MarketData, spaceId: string, now: number): GlanceView {
  const p = portfolioView(db, data, spaceId, now);
  return {
    portfolio: p.empty ? null : { totalCad: p.total?.value ?? null, dayCad: p.dayCad, dayPct: p.dayPct, dayLabel: p.dayLabel, mix: p.mix },
    lists: listsView(db, data, spaceId, now).lists.map((l) => ({
      name: l.name,
      rows: l.rows.map((r) => ({ key: r.key, price: r.price?.value ?? null, ccy: currencyOfKey(r.key), dayPct: r.dayPct, tag: tagOf(r.price) })),
    })),
    earnings: earningsView(db, spaceId, now).rows.map((e) => ({ key: e.key, date: e.date, hour: e.hour, held: e.held })),
    advanced: isAdvanced(db, spaceId),
  };
}
