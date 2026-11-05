import type { Database } from "bun:sqlite";
import { getSetting } from "../settings";
import { cachedQuotes } from "./cache";
import { currentQuote, type MarketData } from "./data";
import { latestFx } from "./fx";
import { lookThrough, type LookThrough } from "./funds/lookthrough";
import { fileFundFor, isFund } from "./funds/sources";
import { fundError, loadFundFile } from "./funds/store";
import { portfolioHealth, type Health, type Position } from "./health";
import { listHoldings } from "./holdings";
import { parseInstrumentKey } from "./instrument";
import { currencyOfKey } from "./labels";
import { getMeta } from "./meta";
import type { Quote } from "./providers/types";
import { etInstant } from "./calendar";
import { closeDayText, etDay, mixLabel, quoteSourced, type Sourced, type Tone } from "./sourced";

// The DB glue for health: cached prices only (through currentQuote, so a demo price never passes for a real one),
// the latest Bank of Canada rate, saved fund files and metadata. Nothing here touches the network.
// now (the market clock) lets a "live" price that has gone stale say so.
export function positionsFor(db: Database, data: MarketData, spaceId: string, now: number = Date.now()): PricedPosition[] {
  return positionsWith(db, spaceId, (key) => currentQuote(db, data, parseInstrumentKey(key)!), now);
}

type PricedPosition = Position & { quoteAt: number | null; freshness: string | null };

function positionsWith(db: Database, spaceId: string, quoteOf: (key: string) => Quote | null, now: number): PricedPosition[] {
  const holdings = listHoldings(db, spaceId);
  const meta = getMeta(db, holdings.map((h) => h.key));
  return holdings.map((h) => {
    const q = quoteOf(h.key);
    const kind = isFund(h.key) ? "etf" : (meta.get(h.key)?.kind ?? "unknown");
    return {
      key: h.key,
      account: h.account,
      accountType: h.accountType ?? null,
      quantity: h.quantity,
      price: q ? quoteSourced(q, now) : null,
      prevClose: q?.prevClose ?? null,
      listingCcy: currencyOfKey(h.key),
      bookValue: h.bookValue,
      bookCcy: h.currency,
      bookValueCad: h.bookValueCad ?? null,
      kind: kind === "unknown" ? "stock" : kind,
      quoteAt: q?.at ?? null,
      freshness: q?.freshness ?? null,
    };
  });
}

// The Bank of Canada rate for the session before the latest priced one, for yesterday's value in CAD.
function fxPrevFor(db: Database, positions: PricedPosition[]): Sourced | null {
  const days = positions.filter((p) => p.price).map((p) => etDay(p.price!.asOf)).sort();
  const latest = days.at(-1);
  if (!latest) return null;
  const r = db.query("SELECT date, rate FROM fx_rates WHERE pair = 'USDCAD' AND date < ? ORDER BY date DESC LIMIT 1").get(latest) as { date: string; rate: number } | null;
  if (!r) return null;
  const asOf = etInstant(r.date, "16:30");
  return { value: r.rate, source: `Bank of Canada · ${closeDayText(asOf)}`, asOf, tone: "official" };
}

// Look-through is recomputed only when a fund's file changes.
const memo = new Map<string, { fetchedAt: number; lt: LookThrough }>();

export function lookThroughFor(db: Database, key: string): LookThrough | null {
  const file = loadFundFile(db, fileFundFor(key));
  if (!file) return null;
  const id = `${key}:${file.fetchedAt}`;
  const hit = memo.get(key);
  if (hit && `${key}:${hit.fetchedAt}` === id) return hit.lt;
  const lt = lookThrough((f) => loadFundFile(db, f), key);
  memo.set(key, { fetchedAt: file.fetchedAt, lt });
  return lt;
}

export function healthFor(db: Database, data: MarketData, spaceId: string, now: number = Date.now()): Health {
  const positions = positionsFor(db, data, spaceId, now);
  const keys = [...new Set(positions.map((p) => p.key))];
  const lts = new Map<string, LookThrough>();
  const unavailable = new Map<string, string>();
  for (const k of keys.filter(isFund)) {
    const lt = lookThroughFor(db, k);
    if (lt) lts.set(k, lt);
    else unavailable.set(k, fundError(db, fileFundFor(k)) ?? "no holdings file yet");
  }
  return portfolioHealth({ positions, fx: latestFx(db), fxPrev: fxPrevFor(db, positions), lookThrough: lts, meta: getMeta(db, keys), unavailable, now });
}

// closes: how many priced holdings are at a previous close rather than live. dayLabel: "today", or the session the
// change is from ("on Fri, Nov 6") when the market hasn't traded today.
export type PortfolioDay = {
  dayPct: number;
  dayCad: number;
  mix: string;
  tone: Tone;
  closes: number;
  dayLabel: string;
  movers: { key: string; dayPct: number; tag: string | null }[];
};

export function portfolioDay(db: Database, data: MarketData, spaceId: string, now: number = Date.now()): PortfolioDay | null {
  return dayOf(db, positionsFor(db, data, spaceId, now), now);
}

// For the Home briefing, which has no MarketData: cached quotes count only when they match the current mode (demo
// prices only in Demo mode, real ones only outside it), the same rule currentQuote applies.
export function portfolioDayFromCache(db: Database, spaceId: string, now: number = Date.now()): PortfolioDay | null {
  const demo = getSetting(db, "markets.provider") === "demo";
  const holdings = listHoldings(db, spaceId);
  const quotes = cachedQuotes(db, holdings.map((h) => h.key));
  return dayOf(
    db,
    positionsWith(db, spaceId, (key) => {
      const q = quotes.get(key);
      return q && (q.source === "demo") === demo ? q : null;
    }, now),
    now,
  );
}

const sessionFmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });

function dayOf(db: Database, all: PricedPosition[], now: number): PortfolioDay | null {
  const positions = all.filter((p) => p.price);
  if (!positions.length) return null;
  const h = portfolioHealth({ positions, fx: latestFx(db), fxPrev: fxPrevFor(db, positions), lookThrough: new Map(), meta: new Map(), now });
  if (!h.dayCad || h.dayPct === null) return null;
  const mix = mixLabel(positions.map((p) => p.price!));
  const seen = new Set<string>();
  const movers = positions
    .filter((p) => p.prevClose && !seen.has(p.key) && seen.add(p.key))
    .map((p) => ({
      key: p.key,
      dayPct: (p.price!.value / p.prevClose! - 1) * 100,
      tag: p.price!.tone === "live" ? null : p.freshness === "demo" ? "demo" : `close ${closeDayText(p.quoteAt!)}`,
    }))
    .sort((a, b) => Math.abs(b.dayPct) - Math.abs(a.dayPct))
    .slice(0, 3);
  const closes = new Set(positions.filter((p) => p.price!.tone === "delayed").map((p) => p.key)).size;
  const dayLabel = h.dayOf === etDay(now) ? "today" : `on ${sessionFmt.format(Date.parse(`${h.dayOf}T12:00:00Z`))}`;
  return { dayPct: h.dayPct, dayCad: h.dayCad.value, mix: mix.text, tone: mix.tone, closes, dayLabel, movers };
}
