import type { Database } from "bun:sqlite";
import { anyAdvanced, bigNewsArmed } from "./advanced";
import { evaluateEvents } from "./alerts";
import { backedOff, backOff } from "./backoff";
import { AV_RESERVE, dailyBudget, noteSourceResult, planAlphaVantage } from "./budget";
import { etDate, etInstant, lastCompletedSession, tsxOpen, tsxTrading } from "./calendar";
import { recordCloses } from "./closes";
import { AV_DAILY_LIMIT, type MarketData } from "./data";
import { fetchNews, saveEarnings } from "./events";
import { trackedInstruments } from "./feed";
import { isFund } from "./funds/sources";
import { instrumentKey, parseInstrumentKey, type Exchange, type Instrument } from "./instrument";
import type { Job, Skipped } from "./jobs";
import type { TiingoProvider } from "./providers/tiingo";
import { ProviderError, type EarningsDate } from "./providers/types";
import { redact } from "./redact";
import { thesisChecks } from "./research";

// Compared against in every performance view, so their history is kept even when nobody holds them.
export const BENCHMARKS = ["SPY", "XEQT.TO"];
const BACKFILL_DAYS = 400;
const DAY_MS = 86_400_000;
const ACTIVE = "SELECT id FROM spaces WHERE kind = 'markets' AND status = 'active'";

const shift = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const isCanadian = (i: Instrument) => i.exchange === "TSX" || i.exchange === "TSXV";

export function heldKeys(db: Database): string[] {
  const rows = db.query(`SELECT DISTINCT symbol, exchange FROM market_holdings WHERE space_id IN (${ACTIVE}) ORDER BY updated_at, rowid`).all() as {
    symbol: string;
    exchange: Exchange;
  }[];
  return [...new Set(rows.map(instrumentKey))];
}

const errorText = (e: unknown, secrets: string[]) => redact(e instanceof Error ? e.message : String(e), secrets);

// Which tracked US stocks the last earnings check covered, and when: catch-up runs it again for a new holding or
// after a day.
export const EARNINGS_CHECKED = "markets.earnings.checked";
export const EARNINGS_DAYS_AHEAD = 30;
const NO_FINNHUB = "add your Finnhub key in Settings → Market data";

type Checked = { at: number; keys: string[] };
const EARNINGS_MAX_AGE = 20 * 3_600_000;
const readChecked = (db: Database): Checked | null => {
  const raw = (db.query("SELECT value FROM settings WHERE key = ?").get(EARNINGS_CHECKED) as { value: string } | null)?.value;
  return raw ? (JSON.parse(raw) as Checked) : null;
};
const usStocks = (db: Database) => trackedInstruments(db).filter((i) => i.exchange === "US" && !isFund(instrumentKey(i)));

// The stocks whose dates are missing or older than 20 hours (a new holding, or a day since the last check), less any
// symbol backed off after its own call failed.
export function earningsDue(db: Database, now: number): Instrument[] {
  const out = backedOff(db, "earnings", now);
  const stocks = usStocks(db).filter((i) => !out.has(instrumentKey(i)));
  const c = readChecked(db);
  if (!c || now - c.at > EARNINGS_MAX_AGE) return stocks;
  return stocks.filter((i) => !c.keys.includes(instrumentKey(i)));
}

// The 16:30 run checks every stock; a catch-up (resume) only the due ones. Finnhub answers per symbol, so a rate limit
// partway keeps the dates already fetched, and the rest are due on the next catch-up.
export async function fetchEarnings(db: Database, data: MarketData, now: number, opts: { resume?: boolean } = {}): Promise<Skipped | null> {
  const out = backedOff(db, "earnings", now);
  const stocks = opts.resume ? earningsDue(db, now) : usStocks(db).filter((i) => !out.has(instrumentKey(i)));
  if (!stocks.length) return null;
  const research = data.research?.();
  if (!research?.earnings) return { step: "earnings", reason: `Earnings dates weren't checked: ${NO_FINNHUB}.`, status: "off" };
  const today = etDate(now);
  const prev = readChecked(db);
  const fresh = prev && now - prev.at <= EARNINGS_MAX_AGE ? prev : null;
  const save = (rows: EarningsDate[], keys: string[]) => {
    saveEarnings(db, rows, "finnhub", { replaceFrom: { keys, from: today } });
    // A partial or due-only check keeps the earlier check's time, so what it didn't cover comes due on time.
    const all = [...new Set([...(fresh?.keys ?? []), ...keys])];
    upsert(db, EARNINGS_CHECKED, JSON.stringify({ at: fresh && keys.length < usStocks(db).length ? fresh.at : now, keys: all }));
  };
  try {
    save(await research.earnings(stocks, today, shift(today, EARNINGS_DAYS_AHEAD)), stocks.map(instrumentKey));
    return null;
  } catch (e) {
    const partial = e instanceof ProviderError ? e.partial : undefined;
    if (partial?.done.length) save(partial.rows, partial.done);
    if (partial?.failed?.length) backOff(db, "earnings", partial.failed.map((f) => f.key), now);
    // Catch-up's own due check brings it back (the rest after a rate limit, a failed symbol after its back-off), so
    // it waits rather than being rerun as a failed step too.
    return { step: "earnings", reason: `Earnings dates failed: ${errorText(e, data.secrets?.() ?? [])}`, status: "waiting" };
  }
}

const upsert = (db: Database, key: string, value: string) =>
  db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);

// The session before the one a date belongs to: its close is the previous close a quote reports.
const sessionBefore = (date: string) => lastCompletedSession(etInstant(date, "00:00")).date;

// Without Tiingo, Atrium's US history is its own closes. The feed keeps the price it fetches at the close, but only
// when it was running through 4 PM; this keeps the close (and the previous close Finnhub reports with it) whenever
// the job runs, so sparklines and performance fill from the first day.
async function ownUsCloses(db: Database, data: MarketData, list: Instrument[], now: number): Promise<Skipped | null> {
  if (!list.length) return null;
  if (!data.research?.()) return { step: "us-closes", reason: `US closes weren't kept: ${NO_FINNHUB}.`, status: "off" };
  const session = lastCompletedSession(now);
  const r = await data.quotes(list);
  for (const q of r.quotes) {
    // Demo prices are made up, and Canadian closes come from Alpha Vantage, never from Yahoo's last trade.
    if (q.source === "alphavantage" || q.source === "yahoo" || q.source === "demo") continue;
    const day = etDate(q.at);
    if (day === session.date && q.at <= session.closesAt + 60_000) recordCloses(db, q.key, [{ date: day, close: q.price, adjClose: null, source: q.source }]);
    if (q.prevClose) recordCloses(db, q.key, [{ date: sessionBefore(day), close: q.prevClose, adjClose: null, source: q.source }]);
  }
  // The next day's previous close fills a missed one, so this waits rather than retrying.
  return r.missing.length
    ? { step: "us-closes", reason: `US closes weren't kept for ${r.missing.map((m) => m.key).join(", ")}: ${r.missing[0]!.reason}`, status: "waiting" }
    : null;
}

// Everything the job fetches for: what the feed tracks plus the benchmarks.
export function eodInstruments(db: Database): Instrument[] {
  const tracked = trackedInstruments(db);
  const seen = new Set(tracked.map(instrumentKey));
  return [...tracked, ...BENCHMARKS.filter((k) => !seen.has(k)).map((k) => parseInstrumentKey(k)!)];
}

// The Canadian listings Atrium keeps closes for, held first, and the session those closes are for.
export const caKeys = (db: Database, all: Instrument[]): string[] =>
  [...new Set([...heldKeys(db).filter((k) => isCanadian(parseInstrumentKey(k)!)), ...all.filter(isCanadian).map(instrumentKey)])];
export const caSession = (now: number): string | null => {
  const { date } = lastCompletedSession(now);
  return tsxTrading(date) ? date : null;
};
export const missingCloses = (db: Database, keys: string[], date: string): string[] => {
  const have = db.query("SELECT 1 FROM market_closes WHERE key = ? AND date = ?");
  return keys.filter((k) => !have.get(k, date));
};

// Catch-up's approved retry: the keys and how many calls it may spend, taken once.
export const CA_BATCH = "markets.av.batch";
function takeBatch(db: Database): string[] | null {
  const raw = (db.query("SELECT value FROM settings WHERE key = ?").get(CA_BATCH) as { value: string } | null)?.value;
  if (!raw) return null;
  db.query("DELETE FROM settings WHERE key = ?").run(CA_BATCH);
  return JSON.parse(raw) as string[];
}

// Only closes still missing for the session are fetched, never ones already saved. batch: the keys catch-up approved
// (already within its budget); otherwise the day's plan. Whatever is still missing afterwards waits, with the reason,
// for catch-up's one retry per key.
async function canadianCloses(db: Database, data: MarketData, all: Instrument[], now: number, batch: string[] | null): Promise<Skipped | null> {
  const date = caSession(now);
  if (!date) return null;
  const keys = caKeys(db, all);
  const missing = missingCloses(db, keys, date);
  if (!missing.length) return null;
  const wait = (reason: string): Skipped => ({ step: "ca-closes", reason, status: "waiting" });
  // In session Canadian prices come from Yahoo, which keeps no closes; asking now would only look like success.
  if (tsxOpen(now)) return wait(`Canadian closes for ${date} wait for Toronto's close.`);
  let fetch: string[];
  let deferred: string[] = [];
  if (batch) fetch = batch.filter((k) => missing.includes(k));
  else {
    const held = heldKeys(db).filter((k) => missing.includes(k));
    const used = AV_DAILY_LIMIT - dailyBudget(db, "alphavantage", AV_DAILY_LIMIT, () => now).remaining();
    const plan = planAlphaVantage({ held, watched: missing, used, limit: AV_DAILY_LIMIT, reserve: AV_RESERVE });
    upsert(db, "markets.av.plan", JSON.stringify(plan.eod));
    upsert(db, "markets.av.deferred", JSON.stringify(plan.deferred));
    fetch = plan.eod;
    deferred = plan.deferred;
  }
  // data.quotes keeps the bars and closes of every daily series it fetches.
  const r = fetch.length ? await data.quotes(fetch.map((k) => parseInstrumentKey(k)!)) : { quotes: [], missing: [] };
  const still = missingCloses(db, keys, date);
  if (!still.length) return null;
  const failed = r.missing.find((m) => still.includes(m.key));
  const why = failed ? failed.reason : deferred.length ? "Alpha Vantage's budget for today is spoken for." : "Alpha Vantage sent no close yet.";
  return wait(`Canadian closes for ${date} weren't saved for ${still.join(", ")}: ${why}`);
}

const STEPS = ["us-history", "us-closes", "ca-closes", "earnings", "thesis", "news"] as const;

// After the close: Tiingo closes and dividends for US listings (or Atrium's own closes without Tiingo), Alpha
// Vantage's daily plan for Canadian ones, then earnings dates. Each step has its own try, so one failing doesn't stop
// the rest. A step that couldn't do its work is returned as skipped, so the data budget page shows it and adding the
// missing key runs that step again, rather than retrying the whole job and spending Alpha Vantage's 25 a day again.
export function eodJob(db: Database, deps: { data: MarketData; tiingo: () => TiingoProvider | null; now: () => number }): Job {
  return {
    name: "eod",
    slot: { at: "16:30", days: "weekdays" },
    async run(now, only) {
      const want = (step: (typeof STEPS)[number]) => !only || only.includes(step);
      const skipped: Skipped[] = [];
      const all = eodInstruments(db);
      const us = all.filter((x) => x.exchange === "US");
      const secrets = deps.data.secrets?.() ?? [];
      await deps.data.prepare?.();
      const today = etDate(now);

      const tiingo = deps.tiingo();
      if (want("us-history") && tiingo) {
        let failed: string | null = null;
        for (const i of us) {
          const key = instrumentKey(i);
          const last = db.query("SELECT MAX(date) AS d FROM market_closes WHERE key = ? AND source = 'tiingo'").get(key) as { d: string | null };
          const start = last.d ? shift(last.d, 1) : shift(today, -BACKFILL_DAYS);
          if (start > today) continue;
          try {
            let days = await tiingo.daily(i, start);
            // A split or a dividend changes every earlier adjusted close, so the whole window is fetched again and
            // the stored rows replaced; otherwise old and new adjustments would mix and show a cliff.
            if (last.d && days.some((d) => d.date >= start && (d.splitFactor !== 1 || d.divCash > 0))) days = await tiingo.daily(i, shift(today, -BACKFILL_DAYS));
            recordCloses(db, key, days.map((d) => ({ date: d.date, close: d.bar.c, adjClose: d.adjClose, source: "tiingo" })));
            const div = db.query("INSERT OR REPLACE INTO market_dividends (key, ex_date, amount, source) VALUES (?, ?, ?, 'tiingo')");
            db.transaction(() => {
              for (const d of days) if (d.divCash > 0) div.run(key, d.date, d.divCash);
            })();
          } catch (e) {
            failed = errorText(e, secrets);
            if (e instanceof ProviderError && (e.kind === "rate_limited" || e.kind === "auth")) break;
          }
        }
        noteSourceResult(db, "tiingo", failed === null, failed ?? undefined, now);
        if (failed) skipped.push({ step: "us-history", reason: `Tiingo history failed: ${failed}` });
      } else if (want("us-history")) skipped.push({ step: "us-history", reason: null, status: "off" });

      if (want("us-closes") && !tiingo) {
        try {
          const s = await ownUsCloses(db, deps.data, us, now);
          if (s) skipped.push(s);
        } catch (e) {
          skipped.push({ step: "us-closes", reason: `US closes failed: ${errorText(e, secrets)}`, status: "waiting" });
        }
      }

      if (want("ca-closes")) {
        try {
          const keyed = (await deps.data.status?.())?.keys.alphavantage ?? true;
          const s = keyed ? await canadianCloses(db, deps.data, all, now, only ? takeBatch(db) : null) : null;
          if (!keyed && all.some(isCanadian)) skipped.push({ step: "ca-closes", reason: null, status: "off" });
          else if (s) skipped.push(s);
        } catch (e) {
          skipped.push({ step: "ca-closes", reason: `Canadian closes failed: ${errorText(e, secrets)}`, status: "waiting" });
        }
      }

      if (want("earnings")) {
        const s = await fetchEarnings(db, deps.data, now, { resume: !!only });
        if (s) skipped.push(s);
        try {
          // Earnings-in-N-days alerts count down on stored dates even when today's check couldn't run.
          evaluateEvents(db, now);
        } catch (e) {
          console.error(`Earnings alerts: ${errorText(e, secrets)}`);
        }
      }

      try {
        // Thesis checks are an Advanced tool.
        if (want("thesis") && anyAdvanced(db)) thesisChecks(db, now);
      } catch (e) {
        console.error(`Thesis checks: ${errorText(e, secrets)}`);
      }

      try {
        // Stored news feeds Advanced tools and big-news alerts; a daily note or an ask fetches its own when it runs.
        if (want("news") && (anyAdvanced(db) || bigNewsArmed(db))) await fetchNews(db, deps.data, now);
      } catch (e) {
        console.error(`End-of-day news: ${errorText(e, secrets)}`);
      }
      return { skipped };
    },
  };
}
