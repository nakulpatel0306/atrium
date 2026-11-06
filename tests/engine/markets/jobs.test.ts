import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../../src/engine/db";
import { createJobs, lastSlot, type Job } from "../../../src/engine/markets/jobs";
import { tempHome } from "../../helpers";

let home: ReturnType<typeof tempHome>;
let db: Database;
beforeEach(() => {
  home = tempHome();
  db = openDb();
});
afterEach(() => {
  db.close();
  home.cleanup();
});

// November 2026 is EST (UTC−5).
const et = (s: string) => Date.parse(`${s}-05:00`);
const MIN = 60_000;

test("lastSlot for a weekday time", () => {
  const slot = { at: "17:00", days: "weekdays" as const };
  expect(lastSlot(et("2026-11-10T08:00:00"), slot)).toBe(et("2026-11-09T17:00:00"));
  expect(lastSlot(et("2026-11-07T12:00:00"), slot)).toBe(et("2026-11-06T17:00:00"));
  expect(lastSlot(et("2026-11-04T17:00:00"), slot)).toBe(et("2026-11-04T17:00:00"));
  expect(lastSlot(et("2026-11-07T12:00:00"), { at: "10:00", days: [6] })).toBe(et("2026-11-07T10:00:00"));
  expect(lastSlot(et("2026-11-07T09:00:00"), { at: "10:00", days: [6] })).toBe(Date.parse("2026-10-31T10:00:00-04:00")); // still EDT
});

test("lastSlot for an hourly window", () => {
  const slot = { everyMinutes: 60, from: "10:00", to: "16:00", days: "weekdays" as const };
  expect(lastSlot(et("2026-11-04T11:59:00"), slot)).toBe(et("2026-11-04T11:00:00"));
  expect(lastSlot(et("2026-11-04T09:00:00"), slot)).toBe(et("2026-11-03T16:00:00"));
  expect(lastSlot(et("2026-11-07T12:00:00"), slot)).toBe(et("2026-11-06T16:00:00"));
});

function counting(name: string, fail = false): Job & { runs: number[] } {
  const runs: number[] = [];
  return {
    name,
    slot: { at: "17:00", days: "weekdays" },
    runs,
    async run(now) {
      runs.push(now);
      if (fail) throw new Error(`${name} could not reach its source.`);
    },
  };
}

test("missed slots run once", async () => {
  const job = counting("fx");
  db.query("INSERT INTO settings (key, value) VALUES ('markets.job.fx', ?)").run(
    JSON.stringify({ ranFor: et("2026-11-05T17:00:00"), lastRunAt: et("2026-11-05T17:01:00"), lastError: null, attempts: 0, lastAttemptAt: null }),
  );
  const jobs = createJobs(db, [job]);
  expect(await jobs.runDue(et("2026-11-09T08:00:00"))).toEqual(["fx"]);
  expect(job.runs).toHaveLength(1);
  const state = JSON.parse((db.query("SELECT value FROM settings WHERE key = 'markets.job.fx'").get() as { value: string }).value);
  expect(state.ranFor).toBe(et("2026-11-06T17:00:00"));
  expect(await jobs.runDue(et("2026-11-09T08:05:00"))).toEqual([]);
  expect(job.runs).toHaveLength(1);
  expect(await jobs.runDue(et("2026-11-09T17:00:00"))).toEqual(["fx"]);
});

test("failures retry three times then wait", async () => {
  const bad = counting("eod", true);
  const good = counting("fx");
  let clock = et("2026-11-04T17:05:00");
  const jobs = createJobs(db, [bad, good], () => clock);
  const T = clock;
  expect(await jobs.runDue(T)).toEqual(["eod", "fx"]);
  expect(await jobs.runDue(T + 10 * MIN)).toEqual([]);
  expect(await jobs.runDue(T + 31 * MIN)).toEqual(["eod"]);
  expect(await jobs.runDue(T + 62 * MIN)).toEqual(["eod"]);
  expect(await jobs.runDue(T + 120 * MIN)).toEqual([]);
  expect(bad.runs).toHaveLength(3);
  clock = T + 120 * MIN;
  const st = jobs.status().find((s) => s.name === "eod")!;
  expect(st.lastError).toBe("eod could not reach its source.");
  expect(st.nextAt).toBe(et("2026-11-05T17:00:00"));
  expect(jobs.status().find((s) => s.name === "fx")!.lastRunAt).toBe(T);
  // The next slot starts fresh.
  expect(await jobs.runDue(et("2026-11-05T17:00:00"))).toEqual(["eod", "fx"]);
});

test("a run that did something tells open dashboards", async () => {
  const { bus } = await import("../../../src/engine/events");
  let changed = 0;
  const off = bus.on((e) => void (e.type === "changed" && changed++));
  const jobs = createJobs(db, [counting("fx")]);
  await jobs.runDue(et("2026-11-04T17:05:00"));
  await jobs.runDue(et("2026-11-04T17:10:00"));
  off();
  expect(changed).toBe(1);
});

// A job with steps: each listed step reports skipped until its key is "added".
function stepped(name: string, keyed: { has: boolean }): Job & { runs: (string[] | undefined)[] } {
  const runs: (string[] | undefined)[] = [];
  return {
    name,
    slot: { at: "17:00", days: "weekdays" },
    runs,
    async run(_now, only) {
      runs.push(only);
      const skipped = [];
      if ((!only || only.includes("earnings")) && !keyed.has) skipped.push({ step: "earnings", reason: "Earnings dates weren't checked: add your Finnhub key." });
      if (!only || only.includes("history")) skipped.push({ step: "history", reason: null });
      return { skipped };
    },
  };
}
const state = (name: string) => JSON.parse((db.query("SELECT value FROM settings WHERE key = ?").get(`markets.job.${name}`) as { value: string }).value);

test("a run with a skipped step isn't recorded as a success, and isn't retried as a failure", async () => {
  const keyed = { has: false };
  const job = stepped("eod", keyed);
  const jobs = createJobs(db, [job], () => et("2026-11-05T19:32:00"));
  expect(await jobs.runDue(et("2026-11-05T19:32:00"))).toEqual(["eod"]);
  expect(jobs.status()[0]!.lastError).toBe("Earnings dates weren't checked: add your Finnhub key.");
  expect(jobs.skipped("eod")).toEqual(["earnings", "history"]);
  // The slot counts as run: no 30-minute retries spending other sources again.
  expect(await jobs.runDue(et("2026-11-05T20:30:00"))).toEqual([]);
  expect(job.runs).toEqual([undefined]);
});

test("after a key is added, only the skipped steps run again", async () => {
  const keyed = { has: false };
  const job = stepped("eod", keyed);
  const other = counting("fx");
  const jobs = createJobs(db, [job, other], () => et("2026-11-05T19:40:00"));
  await jobs.runDue(et("2026-11-05T19:32:00"));
  keyed.has = true;
  expect(await jobs.rerunSkipped(et("2026-11-05T19:40:00"))).toEqual(["eod"]);
  expect(job.runs).toEqual([undefined, ["earnings", "history"]]);
  expect(other.runs).toHaveLength(1);
  expect(jobs.status()[0]!.lastError).toBeNull();
  // A quiet skip (an optional source not set up) stays pending without showing as an error.
  expect(jobs.skipped("eod")).toEqual(["history"]);
  expect(state("eod").ranFor).toBe(et("2026-11-05T17:00:00"));
});

test("runNow runs some steps outside the slot and keeps other steps' pending state", async () => {
  const keyed = { has: false };
  const job = stepped("eod", keyed);
  const jobs = createJobs(db, [job], () => et("2026-11-05T19:40:00"));
  await jobs.runDue(et("2026-11-05T19:32:00"));
  expect(await jobs.runNow("eod", et("2026-11-05T19:45:00"), ["history"])).toBe(true);
  expect(job.runs.at(-1)).toEqual(["history"]);
  expect(jobs.skipped("eod")).toEqual(["earnings", "history"]);
  expect(jobs.status()[0]!.lastError).toBe("Earnings dates weren't checked: add your Finnhub key.");
  expect(await jobs.runNow("nope", et("2026-11-05T19:45:00"))).toBe(false);
});
