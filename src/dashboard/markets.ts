import { useEffect, useState } from "react";
import type { DataStatus } from "../engine/markets/data";
import type { FeedStatus } from "../engine/markets/feed";
import { freshnessText } from "../engine/markets/labels";
import type { Quote } from "../engine/markets/providers/types";
import type { MarketsView } from "../server/markets";
import { onQuotes, useEngineState, useFetched } from "./api";

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
