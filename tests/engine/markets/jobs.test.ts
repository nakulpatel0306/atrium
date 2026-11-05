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
