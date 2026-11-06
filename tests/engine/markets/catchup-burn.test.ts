import { expect, test } from "bun:test";
import { openDb } from "../../../src/engine/db";
import { createSpace } from "../../../src/engine/spaces";
import { dailyBudget } from "../../../src/engine/markets/budget";
import { createCatchUp } from "../../../src/engine/markets/catchup";
import { recordCloses } from "../../../src/engine/markets/closes";
import type { MarketData } from "../../../src/engine/markets/data";
import { eodJob } from "../../../src/engine/markets/eod";
import { instrumentKey, type Instrument } from "../../../src/engine/markets/instrument";
import { createJobs } from "../../../src/engine/markets/jobs";
import { tempHome } from "../../helpers";

// Review repro. XEQT.TO fails every time (a persistent provider error); ATZ and VFV succeed. The feed's off-hours
// steps call catch-up every 15 minutes overnight. Catch-up may retry XEQT once for Monday's session and must leave
// Tuesday's budget alone.
test("a TSX close that keeps failing is retried once per session, and never spends the next day's budget", async () => {
  const home = tempHome();
  const db = openDb();
  const spaceId = createSpace(db, { name: "Investing", kind: "markets", goal: "g" }).id;
  for (const s of ["ATZ", "VFV", "XEQT"]) {
    db.query("INSERT INTO market_holdings (id, space_id, account, symbol, exchange, quantity, currency, source, updated_at) VALUES (?, ?, 'TFSA', ?, 'TSX', 1, 'CAD', 'manual', 1)").run(`h_${s}`, spaceId, s);
  }
  let clock = Date.parse("2026-11-09T21:30:00Z"); // Mon 4:30 PM ET
  const now = () => clock;
  const budget = () => dailyBudget(db, "alphavantage", 25, now);
  const spentByDay: Record<string, number> = {};
  const asked: string[] = [];
  const data = {
    quotes: async (list: Instrument[]) => {
      const missing: { key: string; reason: string }[] = [];
      for (const i of list) {
        if (!budget().spend()) {
          missing.push({ key: instrumentKey(i), reason: "used up" });
          continue;
        }
        asked.push(instrumentKey(i));
        const d = new Date(clock - 5 * 3600e3).toISOString().slice(0, 10);
        spentByDay[d] = (spentByDay[d] ?? 0) + 1;
        if (i.symbol === "XEQT") {
          missing.push({ key: "XEQT.TO", reason: "Alpha Vantage doesn't know XEQT.TO." });
          continue;
        }
        recordCloses(db, instrumentKey(i), [{ date: "2026-11-09", close: 40, adjClose: null, source: "alphavantage" }]);
      }
      return { quotes: [], missing };
    },
    news: async () => [],
    research: () => null,
    status: async () => ({ keys: { alphavantage: true } }),
    prepare: async () => {},
  } as unknown as MarketData;
  const jobs = createJobs(db, [eodJob(db, { data, tiingo: () => null, now })], now);
  const catchUp = createCatchUp(db, { jobs, now });
  await jobs.runDue(clock); // the 16:30 slot
  // Feed off-hours: runDue + unforced catch-up every 15 min for 17 hours (to Tue 9:30 AM).
  for (let t = 0; t < 17 * 4; t++) {
    clock += 15 * 60_000;
    await jobs.runDue(clock);
    await catchUp.run(false);
  }
  expect(spentByDay["2026-11-09"]).toBeLessThanOrEqual(6);
  expect(spentByDay["2026-11-10"] ?? 0).toBe(0);
  // Saved closes are never fetched again: ATZ and VFV once, XEQT at 16:30 and in its one retry.
  expect(asked).toEqual(["ATZ.TO", "VFV.TO", "XEQT.TO", "XEQT.TO"]);
  // Still missing, so it isn't marked done; it waits with the reason.
  expect(jobs.steps("eod")["ca-closes"]).toEqual({ status: "waiting", reason: "Canadian closes for 2026-11-09 weren't saved for XEQT.TO: Alpha Vantage doesn't know XEQT.TO." });
  db.close();
  home.cleanup();
});
