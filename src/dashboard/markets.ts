import { useEffect, useState } from "react";
import type { MarketsBriefing } from "../engine/markets/briefing";
import type { DataStatus } from "../engine/markets/data";
import type { FeedStatus } from "../engine/markets/feed";
import { currencyOfKey, freshnessText } from "../engine/markets/labels";
import type { Quote } from "../engine/markets/providers/types";
import type { MarketsView } from "../server/markets";
import { onQuotes, useEngineState, useFetched } from "./api";
import { money, signedPct } from "./format";

export type { MarketsView };
export type Tone = "live" | "delayed" | "demo" | "none";

export function freshnessLabel(q: Quote | null, missing: string | null): { text: string; tone: Tone } {
  if (!q) return { text: missing ? `No live data: ${missing}` : "No price yet", tone: "none" };
  const tone: Tone = q.freshness === "live" ? "live" : q.freshness === "eod" ? "delayed" : "demo";
  return { text: freshnessText(q), tone };
}

export const dayPct = (q: Quote): number | null => (q.prevClose ? (q.price / q.prevClose - 1) * 100 : null);

// The space's markets view, read again on every engine change, with live ticks patched in between reads.
export function useMarkets(spaceId: string): MarketsView | null {
  const base = useFetched<MarketsView>(`/api/markets/${encodeURIComponent(spaceId)}`, useEngineState());
  const [ticks, setTicks] = useState<Map<string, Quote>>(new Map());
  useEffect(() => setTicks(new Map()), [base]);
  useEffect(
    () =>
      onQuotes((quotes) =>
        setTicks((prev) => {
          const next = new Map(prev);
          for (const q of quotes) next.set(q.key, q);
          return next;
        }),
      ),
    [],
  );
  if (!base || ticks.size === 0) return base;
  // A tick only replaces a price from the same source, so a demo tick can't overwrite a real price or vice versa.
  const patch = <T extends { key: string; quote: Quote | null; missing: string | null }>(x: T): T => {
    const t = ticks.get(x.key);
    return t && (!x.quote || x.quote.source === t.source) ? { ...x, quote: t, missing: null } : x;
  };
  return { ...base, watchlist: base.watchlist.map(patch), holdings: base.holdings.map(patch) };
}

export const useMarketDataSettings = () => useFetched<{ data: DataStatus; feed: FeedStatus }>("/api/settings/market-data", useEngineState());

const signedMoney = (n: number) => `${n >= 0 ? "+" : "−"}${money(Math.abs(n), "USD")}`;
const closeDay = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });

// One line for Home: paper P&L, then the biggest holding moves, each move saying how fresh it is.
export function briefingMarketsLine(m: MarketsBriefing): string | null {
  const parts: string[] = [];
  if (m.paper) parts.push(`Paper ${signedMoney(m.paper.dayPnl)} today (${signedMoney(m.paper.totalPnl)} total)`);
  if (m.holdings.length) {
    const moves = m.holdings.map((h) => {
      const tag = h.freshness === "eod" ? ` (close ${closeDay.format(h.asOf)})` : h.freshness === "demo" ? " (demo)" : "";
      return `${h.key} ${signedPct(h.dayPct, 1)}${tag}`;
    });
    parts.push(`Your holdings: ${moves.join(", ")}`);
  }
  return parts.length ? parts.join(" · ") : null;
}

const etClockFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
export const etClockText = (ms: number) => `${etClockFmt.format(ms)} ET`;

// Market-clock stamps (fills, alert fires) shown in market time rather than "ago", which reads oddly in demo mode.
const etDateTimeFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
export const etDateTimeText = (ms: number) => `${etDateTimeFmt.format(ms)} ET`;

type Cur = "CAD" | "USD";
type Holding = Pick<MarketsView["holdings"][number], "key" | "currency" | "quantity" | "bookValue" | "quote">;

// No FX, so totals are per currency. A price is in the listing's currency (CA$ for .TO/.V/.NE), whatever currency
// the book value was entered in, so market value and day move are grouped by listing and book value by entry.
export function holdingTotals(rows: Holding[]): { value: Partial<Record<Cur, number>>; day: Partial<Record<Cur, number>>; book: Partial<Record<Cur, number>> } {
  const value: Partial<Record<Cur, number>> = {};
  const day: Partial<Record<Cur, number>> = {};
  const book: Partial<Record<Cur, number>> = {};
  for (const h of rows) {
    const listing = currencyOfKey(h.key);
    if (h.quote) {
      value[listing] = (value[listing] ?? 0) + h.quantity * h.quote.price;
      if (h.quote.prevClose) day[listing] = (day[listing] ?? 0) + h.quantity * (h.quote.price - h.quote.prevClose);
    }
    if (h.bookValue !== null) book[h.currency] = (book[h.currency] ?? 0) + h.bookValue;
  }
  return { value, day, book };
}
