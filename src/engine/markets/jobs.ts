import type { Database } from "bun:sqlite";
import { etDate, etInstant } from "./calendar";

// Daily and weekly market jobs. They own no timer: the feed calls runDue at the end of each step, so a job slot
// that passed while the Mac slept runs once on the next step, and an idle engine with nothing tracked runs none.
export type Slot =
  | { at: string /* "HH:MM" ET */; days: "weekdays" | "daily" | number[] /* 0=Sun…6=Sat */ }
  | { everyMinutes: number; from: string; to: string; days: "weekdays" };
export type Job = { name: string; slot: Slot; run(now: number): Promise<void> };
export type JobStatus = { name: string; lastRunAt: number | null; lastError: string | null; nextAt: number | null };

type State = { ranFor: number | null; lastRunAt: number | null; lastError: string | null; attempts: number; lastAttemptAt: number | null; attemptFor?: number | null };

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

export function createJobs(db: Database, jobs: Job[], now: () => number = Date.now) {
  const key = (name: string) => `markets.job.${name}`;
  const read = (name: string): State => {
    const row = db.query("SELECT value FROM settings WHERE key = ?").get(key(name)) as { value: string } | null;
    return row ? (JSON.parse(row.value) as State) : { ranFor: null, lastRunAt: null, lastError: null, attempts: 0, lastAttemptAt: null };
  };
  // Written directly: job bookkeeping shouldn't emit `changed` and wake every listener.
  const write = (name: string, s: State) =>
    db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key(name), JSON.stringify(s));

  return {
    async runDue(at: number): Promise<string[]> {
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
            await job.run(at);
            write(job.name, { ranFor: slot, lastRunAt: at, lastError: null, attempts: 0, lastAttemptAt: at, attemptFor: null });
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
      return ran;
    },
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
