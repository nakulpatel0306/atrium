import type { Database } from "bun:sqlite";
import { AV_RESERVE, dailyBudget } from "./budget";
import { lastCompletedSession, tsxOpen, tsxTrading } from "./calendar";
import { AV_DAILY_LIMIT } from "./data";
import { EARNINGS_CHECKED, heldKeys } from "./eod";
import { trackedInstruments } from "./feed";
import { isFund } from "./funds/sources";
import { instrumentKey, parseInstrumentKey } from "./instrument";
import type { Jobs } from "./jobs";
import { metaStale } from "./meta";

const HOUR_MS = 3_600_000;
// Finnhub's calendar moves; a check older than this is done again.
const EARNINGS_MAX_AGE = 20 * HOUR_MS;
// Between forced runs (engine start, a key added) the feed's steps check at most this often.
const QUIET_MS = HOUR_MS;

export function earningsStale(db: Database, now: number): boolean {
  const stocks = trackedInstruments(db).filter((i) => i.exchange === "US" && !isFund(instrumentKey(i))).map(instrumentKey);
  if (!stocks.length) return false;
  const raw = (db.query("SELECT value FROM settings WHERE key = ?").get(EARNINGS_CHECKED) as { value: string } | null)?.value;
  if (!raw) return true;
  const c = JSON.parse(raw) as { at: number; keys: string[] };
  return now - c.at > EARNINGS_MAX_AGE || stocks.some((k) => !c.keys.includes(k));
}

const TSX_RETRIED = "markets.av.retried";
const isCanadian = (key: string) => ["TSX", "TSXV"].includes(parseInstrumentKey(key)?.exchange ?? "");

// The held Canadian listings with no stored close for the last completed session. Alpha Vantage's per-second notice
// used to be read as its daily limit, which left these empty while the job reported success.
export function tsxClosesMissing(db: Database, now: number): { date: string; keys: string[] } | null {
  const { date } = lastCompletedSession(now);
  if (!tsxTrading(date)) return null;
  const have = db.query("SELECT 1 FROM market_closes WHERE key = ? AND date = ?");
  const keys = heldKeys(db).filter((k) => isCanadian(k) && !have.get(k, date));
  return keys.length ? { date, keys } : null;
}

// Once per session, and only while today's budget has room beyond Nakul's reserve: a real daily-limit notice uses
// the budget up, so it waits for tomorrow, while a throttle misread as one gets its retry.
// While Toronto trades, Canadian prices route to Yahoo, which keeps no closes, so the retry waits for the close.
function tsxRetryDue(db: Database, now: number): string | null {
  if (tsxOpen(now)) return null;
  const missing = tsxClosesMissing(db, now);
  if (!missing) return null;
  const retried = (db.query("SELECT value FROM settings WHERE key = ?").get(TSX_RETRIED) as { value: string } | null)?.value;
  if (retried === missing.date) return null;
  if (dailyBudget(db, "alphavantage", AV_DAILY_LIMIT, () => now).remaining() <= AV_RESERVE) return null;
  return missing.date;
}

// Fills in what the scheduled jobs couldn't: their skipped steps (after a key is added), and earnings dates or
// company metadata that are missing or stale (a new holding, an engine that was off). The checks read only the DB;
// the network is used only for what's due, through the jobs' own steps and budgets. One run at a time.
export function createCatchUp(db: Database, deps: { jobs: Jobs; now: () => number }) {
  let running: Promise<string[]> | null = null;
  let lastAt = 0;
  const run = async (): Promise<string[]> => {
    const now = deps.now();
    lastAt = now;
    const done = await deps.jobs.rerunSkipped(now);
    if (!done.includes("eod") && earningsStale(db, now) && (await deps.jobs.runNow("eod", now, ["earnings"]))) done.push("eod");
    if (!done.includes("meta") && metaStale(db, now) && (await deps.jobs.runNow("meta", now))) done.push("meta");
    const tsx = !done.includes("eod") || !deps.jobs.skipped("eod").includes("ca-closes") ? tsxRetryDue(db, now) : null;
    if (tsx) {
      db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(TSX_RETRIED, tsx);
      if (await deps.jobs.runNow("eod", now, ["ca-closes"])) done.push("eod");
    }
    return done;
  };
  return {
    // force: engine start or a key just added; otherwise at most once an hour.
    async run(force = false): Promise<string[]> {
      if (running) return running;
      if (!force && deps.now() - lastAt < QUIET_MS) return [];
      running = run().finally(() => (running = null));
      return running;
    },
  };
}

export type CatchUp = ReturnType<typeof createCatchUp>;
