import { parseInstrumentKey } from "./instrument";

// Pure: imported by the engine and the dashboard. Maps Atrium keys to TradingView symbols for its free
// Advanced Chart widget, and knows which venues that widget can't show.
export type TvPrefix = "NASDAQ" | "NYSE" | "AMEX" | "CBOE" | "TSX" | "TSXV" | "NEO" | "OTC";

// Each checked against tradingview.com/symbols/<PREFIX>-<SYM>/ on 2026-11-05. TradingView files NYSE Arca under
// AMEX, and the Roundhill ETFs under CBOE.
export const TV_KNOWN: Record<string, string> = {
  AMZN: "NASDAQ:AMZN",
  "ATZ.TO": "TSX:ATZ",
  DRAM: "CBOE:DRAM",
  MARS: "CBOE:MARS",
  META: "NASDAQ:META",
  NOW: "NYSE:NOW",
  QBTS: "NASDAQ:QBTS",
  QQQ: "NASDAQ:QQQ",
  RKLB: "NASDAQ:RKLB",
  SOFI: "NASDAQ:SOFI",
  SPY: "AMEX:SPY",
  TSLA: "NASDAQ:TSLA",
  "VFV.TO": "TSX:VFV",
  "XEQT.TO": "TSX:XEQT",
};

export function tvPrefixFromListing(listing: string | null): TvPrefix | null {
  if (!listing) return null;
  if (/NASDAQ/i.test(listing)) return "NASDAQ";
  if (/NYSE ARCA|NYSE MKT|NYSE AMERICAN|AMEX/i.test(listing)) return "AMEX";
  if (/NEW YORK STOCK EXCHANGE|^NYSE/i.test(listing)) return "NYSE";
  if (/CBOE|BATS/i.test(listing)) return "CBOE";
  return null;
}

export function tvSymbol(key: string, listing?: string | null): string {
  const known = TV_KNOWN[key];
  if (known) return known;
  const i = parseInstrumentKey(key);
  if (!i) return key;
  if (i.exchange !== "US") return `${i.exchange}:${i.symbol}`;
  const prefix = tvPrefixFromListing(listing ?? null);
  // A bare ticker resolves to its primary listing on TradingView.
  return prefix ? `${prefix}:${i.symbol}` : i.symbol;
}

const TV_SYMBOL = /^((NASDAQ|NYSE|AMEX|CBOE|TSX|TSXV|NEO|OTC):)?[A-Z0-9][A-Z0-9.\-]{0,14}$/;
export const isTvSymbol = (s: string): boolean => TV_SYMBOL.test(s);

// Venues the free widget can't show. Cboe BZX isn't in its published market list, but a real-browser check on
// 2026-11-05 showed CBOE:MARS and CBOE:DRAM drawing real candles (Cboe One data), so nothing is listed today.
export const TV_WIDGET_MISSING: { prefix: TvPrefix; venue: string }[] = [];

export function widgetCoverage(tv: string): { ok: true } | { ok: false; reason: string } {
  const prefix = tv.includes(":") ? tv.split(":")[0] : null;
  const missing = TV_WIDGET_MISSING.find((m) => m.prefix === prefix);
  if (!missing) return { ok: true };
  return { ok: false, reason: `TradingView's free chart doesn't cover ${missing.venue} listings, so this is Atrium's chart from its own daily closes.` };
}

export function tvSymbolUrl(tv: string): string {
  return `https://www.tradingview.com/symbols/${tv.replace(":", "-")}/`;
}
