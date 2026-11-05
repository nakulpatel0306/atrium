// Pure: shared by the engine and the dashboard, so it imports types only.
import type { Quote } from "./providers/types";

const dayFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });

export function freshnessText(q: Pick<Quote, "freshness" | "source" | "at">): string {
  if (q.freshness === "demo") return "Demo data";
  if (q.freshness === "eod") return `Delayed · close of ${dayFmt.format(q.at)}`;
  return q.source === "finnhub" ? "Finnhub real-time" : "IEX real-time";
}

const moneyFmt = { CAD: new Intl.NumberFormat("en-US", { style: "currency", currency: "CAD" }), USD: new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }) };

// Prices are in the listing's currency: Canadian listings (.TO, .V, .NE) are CAD, the rest USD.
export const currencyOfKey = (key: string): "CAD" | "USD" => (/\.(TO|V|NE)$/.test(key) ? "CAD" : "USD");

export function money(n: number, currency: "CAD" | "USD"): string {
  const s = moneyFmt[currency].format(Math.abs(n));
  return n < 0 ? `−${s}` : s;
}
