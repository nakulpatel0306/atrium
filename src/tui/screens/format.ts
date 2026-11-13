// Prices and dates as the dashboard writes them, for the terminal's Home and Investing tabs.
import type { Seg } from "../canvas";
import { GLYPH } from "../theme";

const fmt = (n: number, digits: number) => Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
export const cad = (n: number, digits = 2) => `${n < 0 ? "−" : ""}CA$${fmt(n, digits)}`;
export const signedCad = (n: number, digits = 0) => `${n < 0 ? "−" : "+"}CA$${fmt(n, digits)}`;
export const signedPct = (n: number, digits = 1) => `${n < 0 ? "−" : "+"}${fmt(n, digits)}%`;
export const price = (n: number, ccy: "CAD" | "USD") => `${ccy === "USD" ? "US$" : "CA$"}${fmt(n, 2)}`;

const dayFmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
export const dayText = (date: string) => dayFmt.format(Date.parse(`${date}T12:00:00Z`));
export const hourText = (hour: string | null) => (hour === "bmo" ? "before open" : hour === "amc" ? "after close" : "time not set");

// A day's change with its direction as a glyph and a word-free sign, so it reads without color.
export function change(pct: number | null, extra = ""): Seg {
  if (pct === null) return { text: `no change yet${extra}`, color: "faint" };
  const flat = Math.abs(pct) < 0.005;
  return { text: `${flat ? "·" : pct > 0 ? GLYPH.up : GLYPH.down} ${signedPct(pct)}${extra}`, color: flat ? "dim" : pct > 0 ? "ok" : "bad" };
}
