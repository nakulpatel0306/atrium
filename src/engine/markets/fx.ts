import type { Database } from "bun:sqlite";
import { meteredFetch, noteSourceResult } from "./budget";
import { etDate, etInstant } from "./calendar";
import type { Job } from "./jobs";
import { fetchJson } from "./providers/http";
import { ProviderError } from "./providers/types";
import { closeDayText, type Sourced } from "./sourced";

// The Bank of Canada's daily USD/CAD rate: official, keyless, published once a business day around 16:30 ET.
const VALET = "https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json";
const NAME = "Bank of Canada";
const UNREADABLE = `${NAME} sent a reply Atrium couldn't read; it will try again.`;
const PAIR = "USDCAD";
const DAY_MS = 86_400_000;
const BACKFILL_DAYS = 400;
const NEAREST_DAYS = 7;

const isoMinus = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);

export async function fetchUsdCad(opts: { fetch: typeof fetch; now: () => number; startDate?: string }): Promise<{ date: string; rate: number }[]> {
  const url = opts.startDate ? `${VALET}?start_date=${opts.startDate}` : `${VALET}?recent=5`;
  const body = (await fetchJson(url, { fetch: opts.fetch, name: NAME, authMessage: UNREADABLE, now: opts.now })) as { observations?: unknown };
  if (!Array.isArray(body?.observations)) throw new ProviderError("unavailable", UNREADABLE);
  const out: { date: string; rate: number }[] = [];
  for (const o of body.observations as { d?: unknown; FXUSDCAD?: { v?: unknown } }[]) {
    const rate = Number(o?.FXUSDCAD?.v);
    // Canadian holidays come back without a value.
    if (typeof o?.d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(o.d) || !Number.isFinite(rate) || rate <= 0 || o.FXUSDCAD?.v === undefined) continue;
    out.push({ date: o.d, rate });
  }
  return out;
}

export function saveFx(db: Database, rows: { date: string; rate: number }[]): void {
  const q = db.query("INSERT OR REPLACE INTO fx_rates (pair, date, rate) VALUES (?, ?, ?)");
  db.transaction(() => {
    for (const r of rows) q.run(PAIR, r.date, r.rate);
  })();
}

export function latestFx(db: Database): Sourced | null {
  const r = db.query("SELECT date, rate FROM fx_rates WHERE pair = ? ORDER BY date DESC LIMIT 1").get(PAIR) as { date: string; rate: number } | null;
  if (!r) return null;
  const asOf = etInstant(r.date, "16:30");
  return { value: r.rate, source: `${NAME} · ${closeDayText(asOf)}`, asOf, tone: "official" };
}

// The rate on a date, or the nearest business day before it within a week.
export function fxOn(db: Database, date: string): number | null {
  const r = db
    .query("SELECT rate FROM fx_rates WHERE pair = ? AND date <= ? AND date >= ? ORDER BY date DESC LIMIT 1")
    .get(PAIR, date, isoMinus(date, NEAREST_DAYS)) as { rate: number } | null;
  return r?.rate ?? null;
}

export function fxSeries(db: Database, fromDate: string): { date: string; rate: number }[] {
  return db.query("SELECT date, rate FROM fx_rates WHERE pair = ? AND date >= ? ORDER BY date").all(PAIR, fromDate) as { date: string; rate: number }[];
}

export function fxJob(db: Database, deps: { fetch?: typeof fetch; now: () => number }): Job {
  return {
    name: "fx",
    slot: { at: "17:00", days: "weekdays" },
    async run(now) {
      const f = meteredFetch(db, "boc", deps.fetch ?? fetch, deps.now);
      const empty = !db.query("SELECT 1 FROM fx_rates WHERE pair = ? LIMIT 1").get(PAIR);
      try {
        const rows = await fetchUsdCad({ fetch: f, now: deps.now, startDate: empty ? isoMinus(etDate(now), BACKFILL_DAYS) : undefined });
        saveFx(db, rows);
        noteSourceResult(db, "boc", true, undefined, now);
      } catch (e) {
        noteSourceResult(db, "boc", false, e instanceof Error ? e.message : String(e), now);
        throw e;
      }
    },
  };
}
