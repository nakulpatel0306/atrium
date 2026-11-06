// Pure: shared by the engine and the dashboard, so it imports types only.
import type { ProviderId, Quote } from "./providers/types";

const dayFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });

const PROVIDER_NAMES: Record<ProviderId, string> = { alpaca: "Alpaca", finnhub: "Finnhub", alphavantage: "Alpha Vantage", tiingo: "Tiingo", yahoo: "Yahoo Finance", demo: "Demo" };

// A live price this old isn't real-time any more: it was the last trade before the close, or a quiet symbol.
export const STALE_LIVE_MS = 20 * 60_000;
const timeFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
const hourFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

// Yahoo's TSX feed is close to real time, but a thinly traded ETF can go many minutes without a trade, so its price
// is judged by when Atrium fetched it, not by its last trade.
export const YAHOO_FRESH_MS = 10 * 60_000;

// Why a Canadian listing has no price: nothing cached yet, and no source may be asked right now.
export const CA_NOT_PRICED = "Not priced yet. Yahoo Finance fills in during TSX hours (9:30 AM to 4:00 PM ET).";

type Dated = Pick<Quote, "freshness" | "at"> & Partial<Pick<Quote, "source" | "fetchedAt">>;

const isoFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

// A Yahoo price is live only while Toronto's session that traded it is still open: today's trade, fetched in the last
// 10 minutes, before the close (1:00 PM on Christmas Eve and New Year's Eve, 4:00 PM otherwise).
function yahooStale(q: Dated, now: number): boolean {
  const day = isoFmt.format(now);
  const closes = /-12-(24|31)$/.test(day) ? "13:00" : "16:00";
  return isoFmt.format(q.at) !== day || hourFmt.format(now) >= closes || now - (q.fetchedAt ?? q.at) > YAHOO_FRESH_MS;
}

export function isStaleLive(q: Dated, now?: number): boolean {
  if (q.freshness !== "live" || now === undefined) return false;
  if (q.source === "yahoo") return yahooStale(q, now);
  return now - q.at > STALE_LIVE_MS;
}

// The provider and how fresh its number is, e.g. "Finnhub · real-time" or "Alpha Vantage · close of Nov 4". With
// `now`, a live price older than 20 minutes says when it's from instead: the close, or the time of its last trade.
export function freshnessText(q: Pick<Quote, "freshness" | "source" | "at"> & Partial<Pick<Quote, "fetchedAt">>, now?: number): string {
  if (q.freshness === "demo") return "Demo data";
  const name = q.source === "alpaca" ? "Alpaca · IEX" : PROVIDER_NAMES[q.source];
  // Yahoo shows its last trade's time. It never says "close": Yahoo is polled until 4:00 and misses the closing
  // auction, so the close comes only from Alpha Vantage.
  if (q.source === "yahoo") {
    const today = now === undefined || dayFmt.format(q.at) === dayFmt.format(now);
    const when = today ? timeFmt.format(q.at) : `${dayFmt.format(q.at)}, ${timeFmt.format(q.at)}`;
    if (q.freshness === "live" && !isStaleLive(q, now)) return `${name} · last trade ${when}`;
    return today ? `${name} · last price ${when}` : `${name} · last price of ${dayFmt.format(q.at)}`;
  }
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

// With the alert's key, a price is in its listing currency; without one it reads USD, as titles always did.
export function describeRule(rule: AlertRule, key?: string): string {
  const ccy = key ? currencyOfKey(key) : "USD";
  switch (rule.kind) {
    case "price_above":
      return `price above ${money(rule.level, ccy)}`;
    case "price_below":
      return `price below ${money(rule.level, ccy)}`;
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
