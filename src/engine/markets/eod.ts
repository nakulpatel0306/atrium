import type { Database } from "bun:sqlite";
import { anyAdvanced, bigNewsArmed } from "./advanced";
import { evaluateEvents } from "./alerts";
import { AV_RESERVE, dailyBudget, noteSourceResult, planAlphaVantage } from "./budget";
import { etDate, etInstant, lastCompletedSession } from "./calendar";
import { recordCloses } from "./closes";
import { AV_DAILY_LIMIT, type MarketData } from "./data";
import { fetchNews, saveEarnings } from "./events";
import { trackedInstruments } from "./feed";
import { isFund } from "./funds/sources";
import { instrumentKey, parseInstrumentKey, type Exchange, type Instrument } from "./instrument";
import type { Job, Skipped } from "./jobs";
import type { TiingoProvider } from "./providers/tiingo";
import { ProviderError } from "./providers/types";
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

export async function fetchEarnings(db: Database, data: MarketData, now: number): Promise<Skipped | null> {
  const stocks = trackedInstruments(db).filter((i) => i.exchange === "US" && !isFund(instrumentKey(i)));
  if (!stocks.length) return null;
  const research = data.research?.();
  if (!research?.earnings) return { step: "earnings", reason: `Earnings dates weren't checked: ${NO_FINNHUB}.` };
  const today = etDate(now);
  try {
    const rows = await research.earnings(stocks, today, shift(today, EARNINGS_DAYS_AHEAD));
    const keys = stocks.map(instrumentKey);
    saveEarnings(db, rows, "finnhub", { replaceFrom: { keys, from: today } });
    upsert(db, EARNINGS_CHECKED, JSON.stringify({ at: now, keys }));
    return null;
  } catch (e) {
    return { step: "earnings", reason: `Earnings dates failed: ${errorText(e, data.secrets?.() ?? [])}` };
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
  if (!data.research?.()) return { step: "us-closes", reason: `US closes weren't kept: ${NO_FINNHUB}.` };
  const session = lastCompletedSession(now);
  const r = await data.quotes(list);
  for (const q of r.quotes) {
    if (q.source === "alphavantage" || q.source === "yahoo") continue;
    const day = etDate(q.at);
    if (day === session.date && q.at <= session.closesAt + 60_000) recordCloses(db, q.key, [{ date: day, close: q.price, adjClose: null, source: q.source }]);
    if (q.prevClose) recordCloses(db, q.key, [{ date: sessionBefore(day), close: q.prevClose, adjClose: null, source: q.source }]);
  }
  return r.missing.length ? { step: "us-closes", reason: `US closes weren't kept for ${r.missing.map((m) => m.key).join(", ")}: ${r.missing[0]!.reason}` } : null;
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
      const tracked = trackedInstruments(db);
      const seen = new Set(tracked.map(instrumentKey));
      const all = [...tracked, ...BENCHMARKS.filter((k) => !seen.has(k)).map((k) => parseInstrumentKey(k)!)];
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
      } else if (want("us-history")) skipped.push({ step: "us-history", reason: null });

      if (want("us-closes") && !tiingo) {
        try {
          const s = await ownUsCloses(db, deps.data, us, now);
          if (s) skipped.push(s);
        } catch (e) {
          skipped.push({ step: "us-closes", reason: `US closes failed: ${errorText(e, secrets)}` });
        }
      }

      if (want("ca-closes")) {
        try {
          const held = heldKeys(db).filter((k) => isCanadian(parseInstrumentKey(k)!));
          const watched = all.filter(isCanadian).map(instrumentKey);
          const keyed = (await deps.data.status?.())?.keys.alphavantage ?? true;
          if (!keyed && watched.length) skipped.push({ step: "ca-closes", reason: null });
          else {
            const used = AV_DAILY_LIMIT - dailyBudget(db, "alphavantage", AV_DAILY_LIMIT, deps.now).remaining();
            const plan = planAlphaVantage({ held, watched, used, limit: AV_DAILY_LIMIT, reserve: AV_RESERVE });
            upsert(db, "markets.av.plan", JSON.stringify(plan.eod));
            upsert(db, "markets.av.deferred", JSON.stringify(plan.deferred));
            // data.quotes keeps the bars and closes of every daily series it fetches.
            const r = plan.eod.length ? await deps.data.quotes(plan.eod.map((k) => parseInstrumentKey(k)!)) : { missing: [] };
            if (r.missing.length) skipped.push({ step: "ca-closes", reason: `Canadian closes weren't saved for ${r.missing.map((m) => m.key).join(", ")}: ${r.missing[0]!.reason}` });
          }
        } catch (e) {
          skipped.push({ step: "ca-closes", reason: `Canadian closes failed: ${errorText(e, secrets)}` });
        }
      }

      if (want("earnings")) {
        const s = await fetchEarnings(db, deps.data, now);
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
