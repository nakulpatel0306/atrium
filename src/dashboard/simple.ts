import type { PortfolioView, ListsView, EarningsRow } from "../engine/markets/views";
import type { SymbolView } from "../engine/markets/symbol";
import { useEffect, useRef, useState } from "react";
import type { SearchResult } from "../engine/markets/search";
import { post, useEngineState, useFetched } from "./api";
import { navigate } from "./route";

// The simple investing views' client side: the chart frame's address and state, plus hooks and formatting.

// The TradingView page has a listener of its own, at the port and secret path the engine reports, under the other
// loopback name; its code runs cross-origin to the dashboard with no API behind it. Null (the listener didn't
// start) means the Symbol page shows Atrium's chart instead.
export type EmbedInfo = { port: number; token: string } | null;

export function embedOrigin(loc: { hostname: string }, port: number): string {
  return loc.hostname === "localhost" ? `http://127.0.0.1:${port}` : `http://localhost:${port}`;
}

export type TvWidget = "chart" | "mini" | "info" | "profile" | "financials" | "timeline";

export function embedUrl(tv: string, embed: NonNullable<EmbedInfo>, loc: { hostname: string; port: string } = location, w: TvWidget = "chart"): string {
  const q = new URLSearchParams({ symbol: tv, parent: `http://${loc.hostname}:${loc.port}` });
  if (w !== "chart") q.set("w", w);
  return `${embedOrigin(loc, embed.port)}/embed/${encodeURIComponent(embed.token)}/tradingview?${q}`;
}

export type ChartState = "loading" | "ready" | "offline" | "failed";
export type ChartEvent =
  | { type: "start"; online: boolean }
  | { type: "loaded" }
  | { type: "failed" }
  | { type: "timeout" }
  | { type: "online" }
  | { type: "offline" }
  | { type: "retry"; online: boolean };

export const CHART_TIMEOUT_MS = 12_000;

// Nothing reloads by itself: coming back online leaves the offline card up until Try again.
export function chartReducer(s: ChartState, e: ChartEvent): ChartState {
  switch (e.type) {
    case "start":
    case "retry":
      return e.online ? "loading" : "offline";
    case "loaded":
      return s === "loading" || s === "failed" ? "ready" : s;
    case "timeout":
    case "failed":
      return s === "loading" || s === "failed" ? "failed" : s;
    case "offline":
      return s === "loading" ? "offline" : s;
    case "online":
      return s;
  }
}

export type { EarningsRow, ListsView, PortfolioView, SearchResult, SymbolView };
export type EarningsView = { rows: EarningsRow[]; source: string; days: number };

const base = (spaceId: string) => `/api/investing/${encodeURIComponent(spaceId)}`;
export const usePortfolio = (spaceId: string) => useFetched<PortfolioView>(`${base(spaceId)}/portfolio`, useEngineState());
export const useLists = (spaceId: string) => useFetched<ListsView>(`${base(spaceId)}/lists`, useEngineState());
export const useEarnings = (spaceId: string) => useFetched<EarningsView>(`${base(spaceId)}/earnings`, useEngineState());
export const useSymbol = (spaceId: string, key: string | null) =>
  useFetched<SymbolView>(key ? `${base(spaceId)}/symbol/${encodeURIComponent(key)}` : null, useEngineState());
export const investPath = base;

export const openSymbol = (spaceId: string, key: string) => navigate(`/space/${encodeURIComponent(spaceId)}?symbol=${encodeURIComponent(key)}`);
export const closeSymbol = (spaceId: string) => navigate(`/space/${encodeURIComponent(spaceId)}`);

// A sparkline path in a w×h box: the range fills the height less 1px each side; a flat series sits mid-height.
export function sparkPath(values: number[], w: number, h: number): string {
  if (values.length < 2) return "";
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const y = (v: number) => (hi === lo ? h / 2 : 1 + (1 - (v - lo) / (hi - lo)) * (h - 2));
  const x = (i: number) => (i / (values.length - 1)) * w;
  const r = (n: number) => Math.round(n * 100) / 100;
  return values.map((v, i) => `${i ? "L" : "M"}${r(x(i))},${r(y(v))}`).join("");
}

const fmt = (n: number, digits: number) => Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
// Prices carry their currency explicitly: a CAD portfolio holds US listings too.
export const priceText = (n: number, ccy: "CAD" | "USD") => `${ccy === "USD" ? "US$" : "CA$"}${fmt(n, 2)}`;
export const cadText = (n: number, digits = 2) => `${n < 0 ? "−" : ""}CA$${fmt(n, digits)}`;
export const signedCadText = (n: number, digits = 2) => `${n < 0 ? "−" : "+"}CA$${fmt(n, digits)}`;
export const signedPct = (n: number, digits = 1) => `${n < 0 ? "−" : "+"}${fmt(n, digits)}%`;
// The daily note as the page shows it: the page carries "Analysis, not advice." once already, and an agent's bare
// sign-off ("All done.") isn't a note about what moved.
const SIGN_OFF = /^(all done|done|finished|complete|completed|ok|okay)[.!]?$/i;
export function movedNote(body: string): string | null {
  const text = body.replace(/(\s*Analysis, not advice\.?)+\s*$/i, "").trim();
  return text && !SIGN_OFF.test(text) ? text : null;
}

export const toneOf = (n: number | null) => (n === null || Math.abs(n) < 0.005 ? "flat" : n > 0 ? "up" : "down");

const dayFmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
// "2026-11-12" → "Thu, Nov 12".
export const dateHeading = (date: string) => dayFmt.format(Date.parse(`${date}T12:00:00Z`));
export const hourText = (hour: string | null) => (hour === "bmo" ? "before open" : hour === "amc" ? "after close" : "time not set");

// Whether a search box's text should go to the engine: trimmed, non-empty and different from the last sent.
export function nextSearch(prev: string | null, q: string): string | null {
  const t = q.trim();
  return t && t !== prev ? t : null;
}

export const SEARCH_DEBOUNCE_MS = 300;

// Debounced; only the newest reply counts, so a slow answer to "sho" can't replace the one for "shop".
export function useSearch(q: string): { result: SearchResult | null; error: string | null; busy: boolean } {
  const [state, setState] = useState<{ result: SearchResult | null; error: string | null; busy: boolean }>({ result: null, error: null, busy: false });
  const sent = useRef<string | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    if (!q.trim()) {
      sent.current = null;
      seq.current++;
      setState({ result: null, error: null, busy: false });
      return;
    }
    const query = nextSearch(sent.current, q);
    if (!query) return;
    const timer = setTimeout(async () => {
      sent.current = query;
      const mine = ++seq.current;
      setState((s) => ({ ...s, busy: true }));
      const res = await post<SearchResult>("/api/investing/search", { q: query });
      if (mine !== seq.current) return;
      setState(res.ok ? { result: res.data, error: null, busy: false } : { result: null, error: res.error, busy: false });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [q]);
  return state;
}
