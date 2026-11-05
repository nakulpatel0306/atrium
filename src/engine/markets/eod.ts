import type { Database } from "bun:sqlite";
import { evaluateEvents } from "./alerts";
import { AV_RESERVE, dailyBudget, noteSourceResult, planAlphaVantage } from "./budget";
import { etDate } from "./calendar";
import { recordCloses } from "./closes";
import { AV_DAILY_LIMIT, type MarketData } from "./data";
import { fetchNews, saveEarnings } from "./events";
import { trackedInstruments } from "./feed";
import { isFund } from "./funds/sources";
import { instrumentKey, parseInstrumentKey, type Exchange, type Instrument } from "./instrument";
import type { Job } from "./jobs";
import type { TiingoProvider } from "./providers/tiingo";
import { ProviderError } from "./providers/types";
import { redact } from "./redact";

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

// After the close: Tiingo closes and dividends for US listings, then Alpha Vantage's daily plan for Canadian ones.
// Each source has its own try, so one failing doesn't stop the rest; failures show on the data budget page rather
// than retrying the job, which would spend Alpha Vantage's 25 a day again.
export function eodJob(db: Database, deps: { data: MarketData; tiingo: () => TiingoProvider | null; now: () => number }): Job {
  return {
    name: "eod",
    slot: { at: "16:30", days: "weekdays" },
    async run(now) {
      const tracked = trackedInstruments(db);
      const seen = new Set(tracked.map(instrumentKey));
      const all = [...tracked, ...BENCHMARKS.filter((k) => !seen.has(k)).map((k) => parseInstrumentKey(k)!)];
      const secrets = deps.data.secrets?.() ?? [];
      await deps.data.prepare?.();
      const today = etDate(now);

      const tiingo = deps.tiingo();
      if (tiingo) {
        let failed: string | null = null;
        for (const i of all.filter((x) => x.exchange === "US")) {
          const key = instrumentKey(i);
          const last = db.query("SELECT MAX(date) AS d FROM market_closes WHERE key = ? AND source = 'tiingo'").get(key) as { d: string | null };
          const start = last.d ? shift(last.d, 1) : shift(today, -BACKFILL_DAYS);
          if (start > today) continue;
          try {
            const days = await tiingo.daily(i, start);
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
      }

      try {
        const held = heldKeys(db).filter((k) => isCanadian(parseInstrumentKey(k)!));
        const watched = all.filter(isCanadian).map(instrumentKey);
        const used = AV_DAILY_LIMIT - dailyBudget(db, "alphavantage", AV_DAILY_LIMIT, deps.now).remaining();
        const plan = planAlphaVantage({ held, watched, used, limit: AV_DAILY_LIMIT, reserve: AV_RESERVE });
        const write = (k: string, v: string[]) =>
          db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, JSON.stringify(v));
        write("markets.av.plan", plan.eod);
        write("markets.av.deferred", plan.deferred);
        // data.quotes keeps the bars and closes of every daily series it fetches.
        if (plan.eod.length) await deps.data.quotes(plan.eod.map((k) => parseInstrumentKey(k)!));
      } catch (e) {
        console.error(`End-of-day Canadian closes: ${errorText(e, secrets)}`);
      }

      try {
        const research = deps.data.research?.();
        const stocks = all.filter((i) => i.exchange === "US" && !isFund(instrumentKey(i)));
        if (research?.earnings && stocks.length) {
          const rows = await research.earnings(stocks, today, shift(today, 30));
          saveEarnings(db, rows, "finnhub", { replaceFrom: { keys: stocks.map(instrumentKey), from: today } });
        }
        evaluateEvents(db, now);
      } catch (e) {
        console.error(`End-of-day earnings dates: ${errorText(e, secrets)}`);
      }

      try {
        await fetchNews(db, deps.data, now);
      } catch (e) {
        console.error(`End-of-day news: ${errorText(e, secrets)}`);
      }
    },
  };
}
