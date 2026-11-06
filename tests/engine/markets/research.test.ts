import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../../src/engine/db";
import { createSpace } from "../../../src/engine/spaces";
import { listTasks, setTaskStatus } from "../../../src/engine/tasks";
import { saveQuotes } from "../../../src/engine/markets/cache";
import { saveEarnings, saveNews } from "../../../src/engine/markets/events";
import { digestJob, getNotes, latestWriteups, requestThesisDraft, saveNotes, thesisChecks } from "../../../src/engine/markets/research";
import { tempHome } from "../../helpers";

let home: ReturnType<typeof tempHome>;
let db: Database;
let spaceId: string;
beforeEach(() => {
  home = tempHome();
  db = openDb();
  spaceId = createSpace(db, { name: "Investing", kind: "markets", goal: "g" }).id;
});
afterEach(() => {
  db.close();
  home.cleanup();
});

const watch = (space: string, symbol: string, exchange = "US") =>
  db.query("INSERT INTO market_watchlist (space_id, symbol, exchange, name, added_at) VALUES (?, ?, ?, '', 1)").run(space, symbol, exchange);
const WED_1720 = Date.parse("2026-11-04T22:20:00Z");

test("notes and thesis round-trip, within a size limit", () => {
  expect(getNotes(db, spaceId, "NOW")).toEqual({ thesis: "", notes: "", updatedAt: null });
  saveNotes(db, spaceId, "NOW", { thesis: "Platform consolidation wins." });
  saveNotes(db, spaceId, "NOW", { notes: "Q3 call: margins up." });
  expect(getNotes(db, spaceId, "NOW")).toMatchObject({ thesis: "Platform consolidation wins.", notes: "Q3 call: margins up." });
  expect(() => saveNotes(db, spaceId, "NOW", { thesis: "x".repeat(20_001) })).toThrow("Keep it under 20,000 characters.");
});

test("one thesis draft at a time per symbol", () => {
  const t = requestThesisDraft(db, spaceId, "NOW");
  expect(t).toMatchObject({ agent: "claude", purpose: "thesis_draft", subject: "NOW", weight: "light", allowOnBattery: true, title: "Draft a thesis for NOW" });
  expect(() => requestThesisDraft(db, spaceId, "NOW")).toThrow("Claude is already drafting a thesis for NOW.");
  setTaskStatus(db, t.id, "running");
  setTaskStatus(db, t.id, "review");
  expect(requestThesisDraft(db, spaceId, "NOW").id).not.toBe(t.id);
});

test("the digest job queues one Claude digest per space a weekday", async () => {
  watch(spaceId, "RKLB");
  // Something to write about: a headline since the last digest.
  saveNews(db, [{ key: "RKLB", headline: "Rocket Lab wins NASA contract", source: "Reuters", url: "https://x/1", at: WED_1720 - 3_600_000 }], WED_1720);
  const empty = createSpace(db, { name: "Empty", kind: "markets", goal: "g" });
  const job = digestJob(db);
  expect(job).toMatchObject({ name: "digest", slot: { at: "17:15", days: "weekdays" } });
  await job.run(WED_1720);
  const tasks = listTasks(db).filter((t) => t.purpose === "digest");
  expect(tasks.map((t) => [t.spaceId, t.agent, t.title])).toEqual([[spaceId, "claude", "Daily digest: what moved and why"]]);
  expect(tasks.some((t) => t.spaceId === empty.id)).toBe(false);
  await job.run(WED_1720 + 600_000);
  expect(listTasks(db).filter((t) => t.purpose === "digest")).toHaveLength(1);
});

test("no digest about nothing, and no catch-up digest for an earlier day (the first-start repro)", async () => {
  watch(spaceId, "RKLB");
  const job = digestJob(db);
  // Watchlist only, no prices, no news: nothing to say.
  await job.run(WED_1720);
  expect(listTasks(db).filter((t) => t.purpose === "digest")).toHaveLength(0);
  // A first start on Thursday morning finds Wednesday's slot missed; it isn't caught up, even with news.
  saveNews(db, [{ key: "RKLB", headline: "Rocket Lab wins NASA contract", source: "Reuters", url: "https://x/1", at: WED_1720 }], WED_1720);
  await job.run(Date.parse("2026-11-05T14:00:00Z"));
  expect(listTasks(db).filter((t) => t.purpose === "digest")).toHaveLength(0);
  // Priced holdings are enough on their own.
  const other = createSpace(db, { name: "Held", kind: "markets", goal: "g" });
  db.query("INSERT INTO market_holdings (id, space_id, account, symbol, exchange, quantity, currency, source, updated_at) VALUES ('h1', ?, 'TFSA', 'SPY', 'US', 1, 'USD', 'manual', 1)").run(other.id);
  saveQuotes(db, [{ key: "SPY", price: 600, prevClose: 598, at: Date.parse("2026-11-05T21:00:00Z"), source: "finnhub", freshness: "live" }]);
  await job.run(Date.parse("2026-11-05T22:20:00Z"));
  expect(listTasks(db).filter((t) => t.purpose === "digest").map((t) => t.spaceId).sort()).toEqual([other.id, spaceId].sort());
});

test("before earnings: a thesis check, or a reminder when there's no thesis", () => {
  watch(spaceId, "NOW");
  watch(spaceId, "RKLB");
  saveEarnings(db, [{ key: "NOW", date: "2026-11-06", hour: "amc", epsEstimate: 1 }, { key: "RKLB", date: "2026-11-06", hour: "amc", epsEstimate: 1 }], "finnhub");
  saveNotes(db, spaceId, "RKLB", { thesis: "Neutron gets them into medium lift." });
  thesisChecks(db, WED_1720);
  const w = latestWriteups(db, spaceId, { kind: "thesis_check" });
  expect(w.map((x) => [x.key, x.forDate, x.body, x.taskId])).toEqual([
    ["NOW", "2026-11-06", "No thesis yet for NOW. Write one, or ask Claude to draft it, before earnings on Fri, Nov 6.", null],
  ]);
  const checks = listTasks(db).filter((t) => t.purpose === "thesis_check");
  expect(checks.map((t) => [t.subject, t.title, t.agent])).toEqual([["RKLB", "Thesis check before RKLB earnings on 2026-11-06", "claude"]]);
  thesisChecks(db, WED_1720 + 3_600_000);
  expect(listTasks(db).filter((t) => t.purpose === "thesis_check")).toHaveLength(1);
  expect(latestWriteups(db, spaceId, { kind: "thesis_check" })).toHaveLength(1);
});
