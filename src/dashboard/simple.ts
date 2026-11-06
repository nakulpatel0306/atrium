import type { PortfolioView, ListsView, EarningsRow } from "../engine/markets/views";
import type { SymbolView } from "../engine/markets/symbol";
import { useEngineState, useFetched } from "./api";
import { navigate } from "./route";

// The simple investing views' client side: the chart frame's address and state, plus hooks and formatting.

// The TradingView page has a listener of its own, at the port and secret path the engine reports, under the other
// loopback name; its code runs cross-origin to the dashboard with no API behind it. Null (the listener didn't
// start) means the Symbol page shows Atrium's chart instead.
export type EmbedInfo = { port: number; token: string } | null;

export function embedOrigin(loc: { hostname: string }, port: number): string {
  return loc.hostname === "localhost" ? `http://127.0.0.1:${port}` : `http://localhost:${port}`;
}

export function embedUrl(tv: string, embed: NonNullable<EmbedInfo>, loc: { hostname: string; port: string } = location): string {
  const q = new URLSearchParams({ symbol: tv, parent: `http://${loc.hostname}:${loc.port}` });
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

export type { EarningsRow, ListsView, PortfolioView, SymbolView };
export type EarningsView = { rows: EarningsRow[]; source: string };

const base = (spaceId: string) => `/api/investing/${encodeURIComponent(spaceId)}`;
export const usePortfolio = (spaceId: string) => useFetched<PortfolioView>(`${base(spaceId)}/portfolio`, useEngineState());
export const useLists = (spaceId: string) => useFetched<ListsView>(`${base(spaceId)}/lists`, useEngineState());
export const useEarnings = (spaceId: string) => useFetched<EarningsView>(`${base(spaceId)}/earnings`, useEngineState());
export const useSymbol = (spaceId: string, key: string | null) =>
  useFetched<SymbolView>(key ? `${base(spaceId)}/symbol/${encodeURIComponent(key)}` : null, useEngineState());
export const investPath = base;

export const openSymbol = (spaceId: string, key: string) => navigate(`/space/${encodeURIComponent(spaceId)}?symbol=${encodeURIComponent(key)}`);
export const closeSymbol = (spaceId: string) => navigate(`/space/${encodeURIComponent(spaceId)}`);
