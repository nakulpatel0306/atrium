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
import { closeDayText, mixLabel, quoteSourced, type Tone } from "./sourced";

// The DB glue for health: cached prices only (through currentQuote, so a demo price never passes for a real one),
// the latest Bank of Canada rate, saved fund files and metadata. Nothing here touches the network.
export function positionsFor(db: Database, data: MarketData, spaceId: string): PricedPosition[] {
  return positionsWith(db, spaceId, (key) => currentQuote(db, data, parseInstrumentKey(key)!));
}

type PricedPosition = Position & { quoteAt: number | null; freshness: string | null };

function positionsWith(db: Database, spaceId: string, quoteOf: (key: string) => Quote | null): PricedPosition[] {
  const holdings = listHoldings(db, spaceId);
  const meta = getMeta(db, holdings.map((h) => h.key));
  return holdings.map((h) => {
    const q = quoteOf(h.key);
    const kind = isFund(h.key) ? "etf" : (meta.get(h.key)?.kind ?? "unknown");
    return {
      key: h.key,
      account: h.account,
      quantity: h.quantity,
      price: q ? quoteSourced(q) : null,
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

export function healthFor(db: Database, data: MarketData, spaceId: string): Health {
  const positions = positionsFor(db, data, spaceId);
  const keys = [...new Set(positions.map((p) => p.key))];
  const lts = new Map<string, LookThrough>();
  const unavailable = new Map<string, string>();
  for (const k of keys.filter(isFund)) {
    const lt = lookThroughFor(db, k);
    if (lt) lts.set(k, lt);
    else unavailable.set(k, fundError(db, fileFundFor(k)) ?? "no holdings file yet");
  }
  return portfolioHealth({ positions, fx: latestFx(db), lookThrough: lts, meta: getMeta(db, keys), unavailable });
}

// closes: how many priced holdings are at a previous close rather than live.
export type PortfolioDay = { dayPct: number; dayCad: number; mix: string; tone: Tone; closes: number; movers: { key: string; dayPct: number; tag: string | null }[] };

export function portfolioDay(db: Database, data: MarketData, spaceId: string): PortfolioDay | null {
  return dayOf(db, positionsFor(db, data, spaceId));
}

// For the Home briefing, which has no MarketData: cached quotes count only when they match the current mode (demo
// prices only in Demo mode, real ones only outside it), the same rule currentQuote applies.
export function portfolioDayFromCache(db: Database, spaceId: string): PortfolioDay | null {
  const demo = getSetting(db, "markets.provider") === "demo";
  const holdings = listHoldings(db, spaceId);
  const quotes = cachedQuotes(db, holdings.map((h) => h.key));
  return dayOf(
    db,
    positionsWith(db, spaceId, (key) => {
      const q = quotes.get(key);
      return q && (q.source === "demo") === demo ? q : null;
    }),
  );
}

function dayOf(db: Database, all: PricedPosition[]): PortfolioDay | null {
  const positions = all.filter((p) => p.price);
  if (!positions.length) return null;
  const h = portfolioHealth({ positions, fx: latestFx(db), lookThrough: new Map(), meta: new Map() });
  if (!h.dayCad || h.dayPct === null) return null;
  const mix = mixLabel(positions.map((p) => p.price!));
  const seen = new Set<string>();
  const movers = positions
    .filter((p) => p.prevClose && !seen.has(p.key) && seen.add(p.key))
    .map((p) => ({
      key: p.key,
      dayPct: (p.price!.value / p.prevClose! - 1) * 100,
      tag: p.freshness === "live" ? null : p.freshness === "demo" ? "demo" : `close ${closeDayText(p.quoteAt!)}`,
    }))
    .sort((a, b) => Math.abs(b.dayPct) - Math.abs(a.dayPct))
    .slice(0, 3);
  const closes = new Set(positions.filter((p) => p.freshness === "eod").map((p) => p.key)).size;
  return { dayPct: h.dayPct, dayCad: h.dayCad.value, mix: mix.text, tone: mix.tone, closes, movers };
}
