// Pure: shared by the engine and the dashboard, so it imports types only.
import type { ProviderId, Quote } from "./providers/types";

const dayFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });

const PROVIDER_NAMES: Record<ProviderId, string> = { alpaca: "Alpaca", finnhub: "Finnhub", alphavantage: "Alpha Vantage", tiingo: "Tiingo", demo: "Demo" };

// A live price this old isn't real-time any more: it was the last trade before the close, or a quiet symbol.
export const STALE_LIVE_MS = 20 * 60_000;
const timeFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
const hourFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export const isStaleLive = (q: Pick<Quote, "freshness" | "at">, now?: number) => q.freshness === "live" && now !== undefined && now - q.at > STALE_LIVE_MS;

// The provider and how fresh its number is, e.g. "Finnhub · real-time" or "Alpha Vantage · close of Nov 4". With
// `now`, a live price older than 20 minutes says when it's from instead: the close, or the time of its last trade.
export function freshnessText(q: Pick<Quote, "freshness" | "source" | "at">, now?: number): string {
  if (q.freshness === "demo") return "Demo data";
  const name = q.source === "alpaca" ? "Alpaca · IEX" : PROVIDER_NAMES[q.source];
  if (q.freshness === "eod") return `${PROVIDER_NAMES[q.source]} · close of ${dayFmt.format(q.at)}`;
  if (isStaleLive(q, now)) {
    return hourFmt.format(q.at) >= "15:59" ? `${PROVIDER_NAMES[q.source]} · close of ${dayFmt.format(q.at)}` : `${name} as of ${timeFmt.format(q.at)} ET`;
  }
  return q.source === "alpaca" ? "Alpaca · IEX real-time" : `${name} · real-time`;
}

const moneyFmt = { CAD: new Intl.NumberFormat("en-US", { style: "currency", currency: "CAD" }), USD: new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }) };

// Prices are in the listing's currency: Canadian listings (.TO, .V, .NE) are CAD, the rest USD.
export const currencyOfKey = (key: string): "CAD" | "USD" => (/\.(TO|V|NE)$/.test(key) ? "CAD" : "USD");

export function money(n: number, currency: "CAD" | "USD"): string {
  const s = moneyFmt[currency].format(Math.abs(n));
  return n < 0 ? `−${s}` : s;
}

export type AlertRule =
  | { kind: "price_above" | "price_below"; level: number }
  | { kind: "pct_move"; pct: number }
  | { kind: "rsi_below" | "rsi_above"; level: number; period: number }
  | { kind: "cross_above_sma" | "cross_below_sma"; period: number }
  | { kind: "earnings_within"; days: number }
  | { kind: "big_news" };

export function describeRule(rule: AlertRule): string {
  switch (rule.kind) {
    case "price_above":
      return `price above ${money(rule.level, "USD")}`;
    case "price_below":
      return `price below ${money(rule.level, "USD")}`;
    case "pct_move":
      return `moves ${rule.pct}% in a day`;
    case "rsi_below":
      return `RSI(${rule.period}) below ${rule.level}`;
    case "rsi_above":
      return `RSI(${rule.period}) above ${rule.level}`;
    case "cross_above_sma":
      return `crosses above SMA ${rule.period}`;
    case "cross_below_sma":
      return `crosses below SMA ${rule.period}`;
    case "earnings_within":
      return `earnings within ${rule.days} days`;
    case "big_news":
      return "big news";
  }
}
