import type { Database } from "bun:sqlite";
import { getSetting } from "../settings";
import { meteredFetch, noteSourceResult } from "./budget";
import { trackedInstruments } from "./feed";
import { isFund } from "./funds/sources";
import { instrumentKey } from "./instrument";
import { fetchJson } from "./providers/http";
import { ProviderError } from "./providers/types";

// SEC requires a real contact email in the User-Agent and refuses anything else, so the cross-check stays off until
// Nakul types one into Settings. It's only ever sent to sec.gov.
export const edgarUserAgent = (contact: string) => `Atrium personal dashboard ${contact}`;
const CONTACT = "markets.edgar.contact";
const PAUSED = "markets.edgar.pausedUntil";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TICKERS_URL = "https://www.sec.gov/files/company_tickers_exchange.json";
const FACTS_URL = (cik: number) => `https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, "0")}.json`;
const DAY_MS = 86_400_000;
const MONTH_MS = 30 * DAY_MS;
// SEC allows 10 a second; Atrium asks one at a time with a gap.
const GAP_MS = 200;

type Fact = { start?: string; end: string; val: number; form?: string; filed?: string };
const days = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / DAY_MS;
const round2 = (n: number) => Math.round(n * 100) / 100;

// Diluted EPS over the last four quarters: 10-Q quarters, plus each fourth quarter derived as the 10-K's year minus
// that year's three 10-Q quarters. Null when four consecutive quarters can't be found.
export function edgarEpsTtm(facts: unknown): { eps: number; through: string } | null {
  const rows = (facts as { facts?: { "us-gaap"?: { EarningsPerShareDiluted?: { units?: { "USD/shares"?: Fact[] } } } } })?.facts?.["us-gaap"]
    ?.EarningsPerShareDiluted?.units?.["USD/shares"];
  if (!Array.isArray(rows)) return null;
  const quarters = new Map<string, { start: string; end: string; val: number }>();
  const durationOf = (r: Fact) => (r.start ? days(r.start, r.end) : NaN);
  for (const r of rows) {
    const d = durationOf(r);
    if (Number.isFinite(r.val) && r.start && d >= 80 && d <= 100) quarters.set(r.end, { start: r.start, end: r.end, val: r.val });
  }
  for (const r of rows) {
    const d = durationOf(r);
    if (!r.start || r.form !== "10-K" || d < 350 || d > 380 || quarters.has(r.end)) continue;
    const inYear = [...quarters.values()].filter((q) => q.start >= r.start! && q.end < r.end);
    if (inYear.length !== 3) continue;
    const lastEnd = inYear.map((q) => q.end).sort().at(-1)!;
    const start = new Date(Date.parse(lastEnd) + DAY_MS).toISOString().slice(0, 10);
    quarters.set(r.end, { start, end: r.end, val: r.val - inYear.reduce((a, q) => a + q.val, 0) });
  }
  const sorted = [...quarters.values()].sort((a, b) => a.end.localeCompare(b.end)).slice(-4);
  if (sorted.length < 4) return null;
  for (let i = 1; i < 4; i++) if (days(sorted[i - 1]!.end, sorted[i]!.end) > 100) return null;
  return { eps: round2(sorted.reduce((a, q) => a + q.val, 0)), through: sorted[3]!.end };
}

export function crossCheck(pe: number | null, price: number, edgarEps: number | null): { edgarPe: number | null; differs: boolean } {
  const exact = edgarEps !== null && edgarEps > 0 && price > 0 ? price / edgarEps : null;
  // Compared at 0.1% resolution, so a gap of exactly 10% doesn't flip on floating-point dust.
  const gap = pe !== null && exact !== null ? Math.round((Math.abs(exact - pe) / Math.max(exact, pe)) * 1000) / 1000 : 0;
  return { edgarPe: exact === null ? null : round2(exact), differs: gap > 0.1 };
}

const setRaw = (db: Database, key: string, value: string) =>
  db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
const pausedFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });

export function setEdgarContact(db: Database, contact: string): void {
  const c = contact.trim();
  if (!EMAIL.test(c) || c.length > 200) throw new Error("Type an email address like you@example.com.");
  setRaw(db, CONTACT, c);
  // A new contact deserves a fresh try, whatever SEC said to the old one.
  db.query("DELETE FROM settings WHERE key = ?").run(PAUSED);
}

export type EdgarStatus = { on: boolean; contact: string | null; pausedUntil: number | null; note: string | null };

// For Settings and the data budget: off without a contact, paused after a refusal, never shown as an error.
export function edgarStatus(db: Database, now: number): EdgarStatus {
  const contact = getSetting(db, CONTACT);
  const paused = Number(getSetting(db, PAUSED) ?? 0);
  const pausedUntil = paused > now ? paused : null;
  if (!contact) return { on: false, contact: null, pausedUntil: null, note: "Off — add a contact email" };
  if (getSetting(db, "markets.edgar") === "off") return { on: false, contact, pausedUntil, note: "Off" };
  if (pausedUntil) return { on: true, contact, pausedUntil, note: `Paused: SEC refused requests from this contact. Atrium tries again on ${pausedFmt.format(pausedUntil)}.` };
  return { on: true, contact, pausedUntil: null, note: null };
}

// Monthly, for US stocks Atrium tracks. Off with the setting markets.edgar = "off".
export async function refreshEdgar(db: Database, deps: { fetch?: typeof fetch; now: () => number; sleep?: (ms: number) => Promise<void> }): Promise<number> {
  const now = deps.now();
  const status = edgarStatus(db, now);
  if (!status.on || status.pausedUntil) return 0;
  const due = trackedInstruments(db)
    .filter((i) => i.exchange === "US" && !isFund(instrumentKey(i)))
    .map(instrumentKey)
    .filter((key) => {
      const r = db.query("SELECT edgar_at FROM instrument_meta WHERE key = ?").get(key) as { edgar_at: number | null } | null;
      return now - (r?.edgar_at ?? 0) > MONTH_MS;
    });
  if (!due.length) return 0;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const f = meteredFetch(db, "edgar", deps.fetch ?? fetch, deps.now);
  const opts = { fetch: f, name: "SEC EDGAR", authMessage: "SEC EDGAR refused Atrium's request; it will try again next month.", now: deps.now, headers: { "User-Agent": edgarUserAgent(status.contact!) } };
  let asked = 0;
  const pause = async () => {
    if (asked++ > 0) await sleep(GAP_MS);
  };
  try {
    const cached = getSetting(db, "markets.edgar.tickers");
    let map: Record<string, number> | null = null;
    if (cached) {
      const c = JSON.parse(cached) as { at: number; map: Record<string, number> };
      if (now - c.at < MONTH_MS) map = c.map;
    }
    if (!map) {
      await pause();
      const body = (await fetchJson(TICKERS_URL, opts)) as { fields?: string[]; data?: unknown[][] };
      const ti = body.fields?.indexOf("ticker") ?? -1;
      const ci = body.fields?.indexOf("cik") ?? -1;
      if (ti < 0 || ci < 0 || !Array.isArray(body.data)) throw new Error("SEC EDGAR's ticker list has changed shape.");
      map = Object.fromEntries(body.data.map((r) => [String(r[ti]), Number(r[ci])]));
      setRaw(db, "markets.edgar.tickers", JSON.stringify({ at: now, map }));
    }
    let n = 0;
    for (const key of due) {
      const cik = map[key];
      if (!cik) continue;
      await pause();
      const result = edgarEpsTtm(await fetchJson(FACTS_URL(cik), opts));
      db.query("INSERT OR IGNORE INTO instrument_meta (key) VALUES (?)").run(key);
      db.query("UPDATE instrument_meta SET edgar_eps_ttm = ?, edgar_at = ? WHERE key = ?").run(result?.eps ?? null, now, key);
      n++;
    }
    noteSourceResult(db, "edgar", true, undefined, now);
    return n;
  } catch (e) {
    // A refusal (SEC's 403 for a contact it won't accept) pauses the cross-check for a month instead of asking daily.
    if (e instanceof ProviderError && e.kind === "auth") {
      setRaw(db, PAUSED, String(now + MONTH_MS));
      return 0;
    }
    noteSourceResult(db, "edgar", false, e instanceof Error ? e.message : String(e), now);
    throw e;
  }
}
