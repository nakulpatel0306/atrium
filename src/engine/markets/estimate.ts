import type { Database } from "bun:sqlite";
import { etDate } from "./calendar";
import { closeOn, latestClose } from "./closes";
import { fxOn, latestFx } from "./fx";
import type { Quote } from "./providers/types";
import { closeDayText, type Sourced } from "./sourced";

// Listings with no free intraday price, estimated from a US proxy holding the same index. Display only: an
// estimate is never stored as a quote, never fills a total and never fires an alert.
export const ESTIMATED: Record<string, { proxy: string }> = { "VFV.TO": { proxy: "SPY" } };

export function estimateFor(db: Database, key: string, proxyQuote: Quote | null, at: number): Sourced | null {
  const cfg = ESTIMATED[key];
  if (!cfg || !proxyQuote || proxyQuote.key !== cfg.proxy) return null;
  if (proxyQuote.freshness !== "live" && proxyQuote.freshness !== "demo") return null;
  if (etDate(proxyQuote.at) !== etDate(at)) return null;
  const base = latestClose(db, key);
  if (!base || base.date >= etDate(at)) return null;
  const proxyClose = closeOn(db, cfg.proxy, base.date);
  const fx = latestFx(db);
  const fxThen = fxOn(db, base.date);
  if (!proxyClose || !fx || !fxThen) return null;
  const est = ((base.close * proxyQuote.price) / proxyClose.close) * (fx.value / fxThen);
  return {
    value: Math.round(est * 100) / 100,
    source: `Estimate from ${cfg.proxy} × USD/CAD (Bank of Canada ${closeDayText(fx.asOf)})`,
    asOf: proxyQuote.at,
    tone: "estimate",
  };
}
