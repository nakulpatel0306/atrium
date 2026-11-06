import type { Database } from "bun:sqlite";
import { EARNINGS_CHECKED } from "./eod";
import { trackedInstruments } from "./feed";
import { isFund } from "./funds/sources";
import { instrumentKey } from "./instrument";
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
