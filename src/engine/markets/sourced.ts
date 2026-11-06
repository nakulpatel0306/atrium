// Pure: shared by the engine and the dashboard, so it imports types only. Every number Atrium shows carries
// where it came from and how fresh it is.
import { freshnessText, isStaleLive, YAHOO_INTRADAY } from "./labels";
import type { Quote } from "./providers/types";

export type Tone = "live" | "delayed" | "estimate" | "official" | "entered" | "demo" | "none";
export type Sourced<T = number> = { value: T; source: string; asOf: number; tone: Tone };

// Later means less certain; a mix takes its least certain part's tone.
export const TONE_RANK: Tone[] = ["live", "official", "entered", "delayed", "estimate", "demo", "none"];

const dayFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
export const closeDayText = (ms: number): string => dayFmt.format(ms);

// With `now`, a live quote that has gone stale (after the close, or a quiet symbol) is labelled delayed. Yahoo's
// minutes-old price is always delayed.
export function quoteSourced(q: Quote, now?: number): Sourced {
  const tone: Tone = q.freshness === "live" ? (isStaleLive(q, now) || q.source === "yahoo" ? "delayed" : "live") : q.freshness === "eod" ? "delayed" : "demo";
  return { value: q.price, source: freshnessText(q, now), asOf: q.at, tone };
}

const etDayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
// The ET calendar date of an instant, "2026-11-04".
export const etDay = (ms: number): string => etDayFmt.format(ms);

// Today's price, even if delayed (Yahoo's intraday TSX price), rather than an earlier close.
export const isIntraday = (s: Sourced<unknown>): boolean => s.tone === "live" || s.source === YAHOO_INTRADAY;

export const worstTone = (tones: Tone[]): Tone =>
  tones.reduce<Tone>((w, t) => (TONE_RANK.indexOf(t) > TONE_RANK.indexOf(w) ? t : w), "live");

// Inside a mix the provider names are dropped: "10 real-time · 3 close of Nov 4".
function shortSource(s: Sourced<unknown>): string {
  if (s.tone === "live") return "real-time";
  if (s.tone === "estimate") return "estimate";
  const close = s.source.match(/^(?:Alpha Vantage|Tiingo|Alpaca|Finnhub|Yahoo Finance) · (close of .+|a few minutes delayed)$/);
  return close ? close[1]! : s.source;
}

export function mixLabel(parts: Sourced<unknown>[]): { text: string; tone: Tone } {
  if (!parts.length) return { text: "No prices yet", tone: "none" };
  const tone = worstTone(parts.map((p) => p.tone));
  const sources = new Set(parts.map((p) => p.source));
  if (sources.size === 1) return { text: parts[0]!.source, tone };
  const groups = new Map<string, number>();
  for (const p of parts) groups.set(shortSource(p), (groups.get(shortSource(p)) ?? 0) + 1);
  const text = [...groups.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, n]) => `${n} ${label}`)
    .join(" · ");
  return { text, tone };
}

export const fxLabel = (fx: Sourced): string => `at Bank of Canada USD/CAD ${fx.value.toFixed(4)} (${closeDayText(fx.asOf)})`;

// Null when a US amount has no rate to convert at: a CAD total never guesses.
export function toCad(amount: number, ccy: "CAD" | "USD", fx: Sourced | null): number | null {
  if (ccy === "CAD") return amount;
  return fx ? amount * fx.value : null;
}
