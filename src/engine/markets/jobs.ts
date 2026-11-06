import type { Database } from "bun:sqlite";
import { bus } from "../events";
import { etDate, etInstant } from "./calendar";

// Daily and weekly market jobs. They own no timer: the feed calls runDue at the end of each step, so a job slot
// that passed while the Mac slept runs once on the next step, and an idle engine with nothing tracked runs none.
export type Slot =
  | { at: string /* "HH:MM" ET */; days: "weekdays" | "daily" | number[] /* 0=Sun…6=Sat */ }
  | { everyMinutes: number; from: string; to: string; days: "weekdays" };
// A step that couldn't do its work (no key yet, a provider failure) is returned rather than thrown, so the rest of
// the run still counts and that step alone runs again when a key is added. reason is shown on the data budget page;
// null keeps it quiet, for an optional source Nakul hasn't set up.
export type Skipped = { step: string; reason: string | null };
export type JobResult = void | { skipped: Skipped[] };
// only: the steps to run, when catching up on skipped ones; every step otherwise.
export type Job = { name: string; slot: Slot; run(now: number, only?: string[]): Promise<JobResult> };
export type JobStatus = { name: string; lastRunAt: number | null; lastError: string | null; nextAt: number | null };

type State = {
  ranFor: number | null;
  lastRunAt: number | null;
  lastError: string | null;
  attempts: number;
  lastAttemptAt: number | null;
  attemptFor?: number | null;
  skipped?: string[];
};

const DAY_MS = 86_400_000;
const LOOK_DAYS = 8;
const RETRY_MS = 30 * 60_000;
const MAX_ATTEMPTS = 3;

const shiftDate = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const dow = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

function dayMatches(slot: Slot, date: string): boolean {
  const d = dow(date);
  if (slot.days === "daily") return true;
  if (slot.days === "weekdays") return d !== 0 && d !== 6;
  return slot.days.includes(d);
}

function instantsOn(slot: Slot, date: string): number[] {
  if (!dayMatches(slot, date)) return [];
  if ("at" in slot) return [etInstant(date, slot.at)];
  const from = etInstant(date, slot.from);
  const to = etInstant(date, slot.to);
  const out: number[] = [];
  for (let t = from; t <= to; t += slot.everyMinutes * 60_000) out.push(t);
  return out;
}

// The most recent slot instant at or before now, or null if none in the last eight days.
export function lastSlot(now: number, slot: Slot): number | null {
  const today = etDate(now);
  for (let i = 0; i <= LOOK_DAYS; i++) {
    const past = instantsOn(slot, shiftDate(today, -i)).filter((t) => t <= now);
    if (past.length) return past.at(-1)!;
  }
  return null;
}

export function nextSlot(now: number, slot: Slot): number | null {
  const today = etDate(now);
  for (let i = 0; i <= LOOK_DAYS; i++) {
    const next = instantsOn(slot, shiftDate(today, i)).find((t) => t > now);
    if (next !== undefined) return next;
  }
  return null;
}

const skippedOf = (r: JobResult): Skipped[] => (r && "skipped" in r ? r.skipped : []);
const errorOf = (skipped: Skipped[]): string | null => {
  const reasons = [...new Set(skipped.flatMap((s) => (s.reason ? [s.reason] : [])))];
  return reasons.length ? reasons.join(" ") : null;
};

export function createJobs(db: Database, jobs: Job[], now: () => number = Date.now) {
  const key = (name: string) => `markets.job.${name}`;
  const read = (name: string): State => {
    const row = db.query("SELECT value FROM settings WHERE key = ?").get(key(name)) as { value: string } | null;
    return row ? (JSON.parse(row.value) as State) : { ranFor: null, lastRunAt: null, lastError: null, attempts: 0, lastAttemptAt: null };
  };
  // Written directly: job bookkeeping shouldn't emit `changed` and wake every listener.
  const write = (name: string, s: State) =>
    db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key(name), JSON.stringify(s));

  // runDue and catch-up runs never overlap, so a step isn't fetched twice at once.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
  };

  // Outside any slot: the given steps (or all), merged into the job's state; its slot bookkeeping is untouched.
  const runNow = async (job: Job, at: number, only?: string[]): Promise<void> => {
    const s = read(job.name);
    try {
      const skipped = skippedOf(await job.run(at, only));
      const kept = only ? (s.skipped ?? []).filter((x) => !only.includes(x)) : [];
      const steps = [...new Set([...kept, ...skipped.map((x) => x.step)])];
      // A reason for a step that isn't run again here stays as it was.
      const keptError = only && kept.length ? s.lastError : null;
      write(job.name, { ...s, lastRunAt: at, lastError: [keptError, errorOf(skipped)].filter(Boolean).join(" ") || null, skipped: steps });
    } catch (e) {
      write(job.name, { ...s, lastRunAt: at, lastError: e instanceof Error ? e.message : String(e) });
    }
  };

  return {
    runDue: (at: number): Promise<string[]> => serial(async () => {
      const ran: string[] = [];
      for (const job of jobs) {
        try {
          const slot = lastSlot(at, job.slot);
          const s = read(job.name);
          if (slot === null || (s.ranFor !== null && slot <= s.ranFor)) continue;
          const attempts = s.attemptFor === slot ? s.attempts : 0;
          if (attempts > 0 && s.lastAttemptAt !== null && at - s.lastAttemptAt < RETRY_MS) continue;
          ran.push(job.name);
          try {
            const skipped = skippedOf(await job.run(at));
            write(job.name, { ranFor: slot, lastRunAt: at, lastError: errorOf(skipped), attempts: 0, lastAttemptAt: at, attemptFor: null, skipped: skipped.map((x) => x.step) });
          } catch (e) {
            const n = attempts + 1;
            const message = e instanceof Error ? e.message : String(e);
            // After three tries the slot is given up; the error stays for the data budget page.
            write(job.name, { ...s, ranFor: n >= MAX_ATTEMPTS ? slot : s.ranFor, lastError: message, attempts: n, lastAttemptAt: at, attemptFor: slot });
          }
        } catch (e) {
          console.error(`Market job ${job.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      // Pages read what the jobs stored; one change event lets an open dashboard pick it up.
      if (ran.length) bus.emit({ type: "changed" });
      return ran;
    }),
    // After a key is added: each job's skipped steps run again, and only those.
    rerunSkipped: (at: number): Promise<string[]> => serial(async () => {
      const ran: string[] = [];
      for (const job of jobs) {
        const steps = read(job.name).skipped ?? [];
        if (!steps.length) continue;
        ran.push(job.name);
        await runNow(job, at, steps);
      }
      if (ran.length) bus.emit({ type: "changed" });
      return ran;
    }),
    // A catch-up run of one job's steps, e.g. earnings dates that are missing or stale.
    runNow: (name: string, at: number, only?: string[]): Promise<boolean> => serial(async () => {
      const job = jobs.find((j) => j.name === name);
      if (!job) return false;
      await runNow(job, at, only);
      bus.emit({ type: "changed" });
      return true;
    }),
    skipped: (name: string): string[] => read(name).skipped ?? [],
    status(): JobStatus[] {
      const at = now();
      return jobs.map((j) => {
        const s = read(j.name);
        return { name: j.name, lastRunAt: s.lastRunAt, lastError: s.lastError, nextAt: nextSlot(at, j.slot) };
      });
    },
  };
}

export type Jobs = ReturnType<typeof createJobs>;
