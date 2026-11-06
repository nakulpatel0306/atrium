// Pure: the portfolio against SPY and XEQT over 1M, 3M, YTD and 1Y, in CAD. Never over a shorter window than asked.
import type { Close } from "./closes";
import { currencyOfKey } from "./labels";

export type Period = "1M" | "3M" | "YTD" | "1Y";
export type PerfResult = {
  period: Period;
  start: string;
  end: string;
  portfolioPct: number | null;
  benchmarks: { key: string; pct: number | null; reason: string | null }[];
  // Per leg: adjusted closes where Atrium has them (total return), raw closes otherwise; "mixed" when legs differ.
  basis: "total return" | "price" | "mixed";
  missing: { key: string; reason: string }[];
  note: string;
};

const NOTE = "Current holdings as if held for the whole period, in CAD at Bank of Canada rates.";
const DAY_MS = 86_400_000;
const START_SLACK_DAYS = 5;
const MISSING_SHARE = 0.1;

const iso = (y: number, m: number, d: number) => {
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1, Math.min(d, last))).toISOString().slice(0, 10);
};

export function periodStart(period: Period, today: string): string {
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  if (period === "YTD") return `${y - 1}-12-31`;
  if (period === "1Y") return iso(y - 1, m, d);
  const back = period === "1M" ? 1 : 3;
  const mm = m - back;
  return mm >= 1 ? iso(y, mm, d) : iso(y - 1, mm + 12, d);
}

type Leg = { key: string; startCad: number; endCad: number; adjusted: boolean } | { key: string; reason: string; endCad: number | null };

const shiftIso = (iso: string, days: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
// Weekdays after `from` up to and including `to`.
function weekdaysBetween(from: string, to: string): number {
  let n = 0;
  for (let d = shiftIso(from, 1); d <= to; d = shiftIso(d, 1)) {
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  return n;
}

function leg(key: string, ccy: "CAD" | "USD", i: { closes: (key: string, from: string) => Close[]; fxOn: (date: string) => number | null }, start: string, today: string, period: Period): Leg {
  const stored = i.closes(key, "1900-01-01").filter((c) => c.date <= today);
  // Never mix raw and adjusted closes: with any adjusted ones (Tiingo), only those count, and a raw trailing close
  // (the feed's own capture) is ignored rather than compared against split-adjusted history.
  const adjusted = stored.some((c) => c.adjClose !== null);
  const all = adjusted ? stored.filter((c) => c.adjClose !== null) : stored;
  const window = all.filter((c) => c.date >= start);
  const first = window[0];
  const last = all.at(-1);
  const usd = ccy === "USD";
  const cad = (c: Close, v: number) => (usd ? (i.fxOn(c.date) === null ? null : v * i.fxOn(c.date)!) : v);
  const endPlain = last ? cad(last, last.close) : null;
  if (!first || (Date.parse(first.date) - Date.parse(start)) / DAY_MS > START_SLACK_DAYS) {
    // How long until the period works: the first stored close has to fall within a few days of the start.
    const firstDate = all[0]?.date;
    const wait = firstDate ? weekdaysBetween(start, shiftIso(firstDate, -START_SLACK_DAYS)) : null;
    const when = wait !== null && wait > 0 ? `; ${period} works after about ${wait} more trading days` : "";
    return { key, reason: `n/a: Atrium has ${all.length} days of ${key} closes${when}`, endCad: endPlain };
  }
  const pick = (c: Close) => (adjusted ? c.adjClose! : c.close);
  const s = cad(first, pick(first));
  const e = cad(last!, pick(last!));
  if (s === null || e === null) return { key, reason: `n/a: no USD/CAD rate for ${s === null ? first.date : last!.date}`, endCad: endPlain };
  return { key, startCad: s, endCad: e, adjusted };
}

export function performance(
  i: { holdings: { key: string; quantity: number; listingCcy: "CAD" | "USD" }[]; closes: (key: string, from: string) => Close[]; fxOn: (date: string) => number | null; today: string },
  period: Period,
  benchmarks = ["SPY", "XEQT.TO"],
): PerfResult {
  const start = periodStart(period, i.today);
  const qty = new Map<string, number>();
  const ccy = new Map<string, "CAD" | "USD">();
  for (const h of i.holdings) {
    qty.set(h.key, (qty.get(h.key) ?? 0) + h.quantity);
    ccy.set(h.key, h.listingCcy);
  }
  const legs = [...qty.keys()].map((k) => leg(k, ccy.get(k)!, i, start, i.today, period));
  const missing = legs.filter((l): l is Extract<Leg, { reason: string }> => "reason" in l).map((l) => ({ key: l.key, reason: l.reason }));
  const used = legs.filter((l): l is Extract<Leg, { startCad: number }> => "startCad" in l);
  const usedNow = used.reduce((a, l) => a + qty.get(l.key)! * l.endCad, 0);
  const missingNow = legs.filter((l) => "reason" in l).reduce((a, l) => a + qty.get(l.key)! * (l.endCad ?? 0), 0);
  const startValue = used.reduce((a, l) => a + qty.get(l.key)! * l.startCad, 0);
  const tooMuchMissing = missingNow > MISSING_SHARE * (usedNow + missingNow);
  const portfolioPct = used.length && startValue > 0 && !tooMuchMissing ? (usedNow / startValue - 1) * 100 : null;
  const bench = benchmarks.map((k) => {
    const l = leg(k, currencyOfKey(k), i, start, i.today, period);
    return "reason" in l ? { key: k, pct: null, reason: l.reason, adjusted: true } : { key: k, pct: (l.endCad / l.startCad - 1) * 100, reason: null, adjusted: l.adjusted };
  });
  const bases = [...used.map((l) => l.adjusted), ...bench.filter((b) => b.pct !== null).map((b) => b.adjusted)];
  const basis = bases.every(Boolean) ? "total return" : bases.some(Boolean) ? "mixed" : "price";
  return {
    period,
    start,
    end: i.today,
    portfolioPct,
    benchmarks: bench.map(({ key, pct, reason }) => ({ key, pct, reason })),
    basis,
    missing,
    note: NOTE,
  };
}
