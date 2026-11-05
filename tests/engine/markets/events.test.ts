import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../../src/engine/db";
import { createSpace } from "../../../src/engine/spaces";
import type { MarketData } from "../../../src/engine/markets/data";
import { newsJob, recentNews, saveEarnings, saveNews, upcomingEarnings } from "../../../src/engine/markets/events";
import { createJobs } from "../../../src/engine/markets/jobs";
import type { Instrument } from "../../../src/engine/markets/instrument";
import type { NewsItem } from "../../../src/engine/markets/providers/types";
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

const NOW = Date.parse("2026-11-05T16:00:00Z");
const DAY = 86_400_000;

test("Nakul's own earnings date survives a Finnhub save", () => {
  saveEarnings(db, [{ key: "ATZ.TO", date: "2026-11-12", hour: "bmo", epsEstimate: null }], "you");
  saveEarnings(db, [{ key: "ATZ.TO", date: "2026-11-14", hour: null, epsEstimate: 0.4 }, { key: "RKLB", date: "2026-11-10", hour: "amc", epsEstimate: 1.23 }], "finnhub");
  expect(upcomingEarnings(db, ["ATZ.TO", "RKLB"], "2026-11-05", 30)).toEqual([
    { key: "RKLB", date: "2026-11-10", hour: "amc", epsEstimate: 1.23, source: "finnhub" },
    { key: "ATZ.TO", date: "2026-11-12", hour: "bmo", epsEstimate: null, source: "you" },
  ]);
  expect(upcomingEarnings(db, ["RKLB"], "2026-11-11", 30)).toEqual([]);
});

test("a moved Finnhub date replaces the old one", () => {
  saveEarnings(db, [{ key: "RKLB", date: "2026-11-10", hour: "amc", epsEstimate: 1 }], "finnhub");
  saveEarnings(db, [{ key: "RKLB", date: "2026-11-12", hour: "amc", epsEstimate: 1 }], "finnhub", { replaceFrom: { keys: ["RKLB"], from: "2026-11-05" } });
  expect(upcomingEarnings(db, ["RKLB"], "2026-11-05", 30).map((e) => e.date)).toEqual(["2026-11-12"]);
});

test("news dedupes and old items are dropped", () => {
  const item = (url: string, at: number): NewsItem => ({ key: "RKLB", headline: `h ${url}`, source: "Reuters", url, at });
  saveNews(db, [item("https://x/1", NOW - 3600_000), item("https://x/old", NOW - 31 * DAY)], NOW);
  saveNews(db, [item("https://x/1", NOW - 3600_000), item("https://x/2", NOW - 60_000)], NOW);
  expect(recentNews(db, ["RKLB"], NOW - 40 * DAY, 10).map((n) => n.url)).toEqual(["https://x/2", "https://x/1"]);
  expect(recentNews(db, ["RKLB"], NOW - 40 * DAY, 1)).toHaveLength(1);
  expect(recentNews(db, ["NOW"], 0, 10)).toEqual([]);
});

test("the news job fetches hourly in session, never on a Saturday", async () => {
  const space = createSpace(db, { name: "Investing", kind: "markets", goal: "g" });
  for (const [s, e] of [["RKLB", "US"], ["SPY", "US"]] as const) db.query("INSERT INTO market_watchlist (space_id, symbol, exchange, name, added_at) VALUES (?, ?, ?, '', 1)").run(space.id, s, e);
  const asked: { list: string[]; since: number }[] = [];
  const data = {
    news: async (list: Instrument[], since: number) => {
      asked.push({ list: list.map((i) => i.symbol), since });
      return [{ key: "RKLB", headline: "Rocket Lab wins NASA contract", source: "Reuters", url: `https://x/${clock}`, at: clock - 60_000 }];
    },
  } as unknown as MarketData;
  let clock = Date.parse("2026-11-06T21:05:00Z"); // Fri 16:05 ET
  const job = newsJob(db, { data, now: () => clock });
  expect(job.slot).toEqual({ everyMinutes: 60, from: "10:00", to: "16:00", days: "weekdays" });
  const jobs = createJobs(db, [job], () => clock);
  expect(await jobs.runDue(clock)).toEqual(["news"]);
  // ETFs aren't asked for company news; the first fetch looks back a day.
  expect(asked).toEqual([{ list: ["RKLB"], since: clock - DAY }]);
  clock = Date.parse("2026-11-07T15:00:00Z"); // Sat 10:00 ET
  expect(await jobs.runDue(clock)).toEqual([]);
  clock = Date.parse("2026-11-09T15:30:00Z"); // Mon 10:30 ET
  expect(await jobs.runDue(clock)).toEqual(["news"]);
  // Never more than a day back, however old the newest stored item is.
  expect(asked[1]!.since).toBe(clock - DAY);
  clock += 3600_000;
  await jobs.runDue(clock);
  expect(asked[2]!.since).toBe(Date.parse("2026-11-09T15:29:00Z"));
});
