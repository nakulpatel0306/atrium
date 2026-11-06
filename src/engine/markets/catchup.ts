import type { Database } from "bun:sqlite";
import { AV_RESERVE, dailyBudget } from "./budget";
import { etDate, etInstant, tsxOpen, tsxTrading } from "./calendar";
import { AV_DAILY_LIMIT } from "./data";
import { CA_BATCH, caKeys, caSession, earningsDue, eodInstruments, missingCloses } from "./eod";
import type { Jobs } from "./jobs";
import { metaStale } from "./meta";

const HOUR_MS = 3_600_000;
// Between forced runs (engine start, a key added) the feed's steps check at most this often.
const QUIET_MS = HOUR_MS;
// Which keys catch-up has already retried for which session, so each key gets one retry per session.
const CA_ATTEMPTS = "markets.av.catchup";

const setting = (db: Database, key: string) => (db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null)?.value ?? null;
const upsert = (db: Database, key: string, value: string) =>
  db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);

export const earningsStale = (db: Database, now: number): boolean => earningsDue(db, now).length > 0;

// The Canadian listings with no stored close for the last completed session.
export function tsxClosesMissing(db: Database, now: number): { date: string; keys: string[] } | null {
  const date = caSession(now);
  if (!date) return null;
  const keys = missingCloses(db, caKeys(db, eodInstruments(db)), date);
  return keys.length ? { date, keys } : null;
}

// One retry per missing key per session, recorded before it's sent. It waits while Toronto trades (Yahoo prices the
// day and keeps no closes), and spends only what's left after Nakul's reserve and, before today's 16:30 run, after
// that run's share: yesterday's close never takes today's.
async function tsxRetry(db: Database, jobs: Jobs, now: number): Promise<boolean> {
  if (tsxOpen(now)) return false;
  const missing = tsxClosesMissing(db, now);
  if (!missing) return false;
  const raw = setting(db, CA_ATTEMPTS);
  const tried = raw && (JSON.parse(raw) as { date: string }).date === missing.date ? (JSON.parse(raw) as { keys: string[] }).keys : [];
  const todo = missing.keys.filter((k) => !tried.includes(k));
  if (!todo.length) return false;
  const today = etDate(now);
  const tonight = today !== missing.date && tsxTrading(today) && (jobs.ranFor("eod") ?? 0) < etInstant(today, "16:30") ? caKeys(db, eodInstruments(db)).length : 0;
  const available = dailyBudget(db, "alphavantage", AV_DAILY_LIMIT, () => now).remaining() - AV_RESERVE - tonight;
  if (available <= 0) {
    jobs.mark("eod", "ca-closes", {
      status: "waiting",
      reason: `Canadian closes for ${missing.date} wait for ${missing.keys.join(", ")}: Alpha Vantage's budget is kept for ${tonight ? "tonight's closes" : "your own use"}.`,
    });
    return false;
  }
  const batch = todo.slice(0, available);
  upsert(db, CA_ATTEMPTS, JSON.stringify({ date: missing.date, keys: [...tried, ...batch] }));
  upsert(db, CA_BATCH, JSON.stringify(batch));
  return jobs.runNow("eod", now, ["ca-closes"]);
}

// Fills in what the scheduled jobs couldn't: their failed steps, steps that were off for want of a key (on start and
// when a key is added), earnings dates or company metadata that are missing or stale (a new holding, an engine that
// was off), and one retry per missing TSX close. Each check reads only the DB and stands on its own; the network is
// used only for what's due, through the jobs' own steps and budgets. One run at a time.
export function createCatchUp(db: Database, deps: { jobs: Jobs; now: () => number }) {
  let running: Promise<string[]> | null = null;
  let lastAt = 0;
  const run = async (force: boolean): Promise<string[]> => {
    const now = deps.now();
    lastAt = now;
    const done = new Set(await deps.jobs.rerunSkipped(now, force));
    if (earningsStale(db, now) && (await deps.jobs.runNow("eod", now, ["earnings"]))) done.add("eod");
    if (metaStale(db, now) && (await deps.jobs.runNow("meta", now))) done.add("meta");
    if (await tsxRetry(db, deps.jobs, now)) done.add("eod");
    return [...done];
  };
  return {
    // force: engine start or a key just added; otherwise at most once an hour.
    async run(force = false): Promise<string[]> {
      if (running) return running;
      if (!force && deps.now() - lastAt < QUIET_MS) return [];
      running = run(force).finally(() => (running = null));
      return running;
    },
  };
}

export type CatchUp = ReturnType<typeof createCatchUp>;
