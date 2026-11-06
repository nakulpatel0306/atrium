import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { openDb } from "../../../src/engine/db";
import { listActivity } from "../../../src/engine/events";
import { getSetting, setSetting } from "../../../src/engine/settings";
import { createSpace, listSpaces } from "../../../src/engine/spaces";
import { INVESTING_TICKERS, seedInvesting, seedOnBoot } from "../../../src/engine/markets/seed";
import { addToWatchlist, listWatchlist } from "../../../src/engine/markets/watchlist";
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

const KEYS = ["ATZ.TO", "NOW", "TSLA", "AMZN", "MARS", "DRAM", "SPY", "VFV.TO", "QQQ", "QBTS", "SOFI", "RKLB", "XEQT.TO"];

test("seedInvesting creates the Investing space with the 13 tickers, once", () => {
  expect(INVESTING_TICKERS.map((t) => t.key)).toEqual(KEYS);
  const r = seedInvesting(db);
  expect(r).toMatchObject({ created: true, added: 13 });
  const space = listSpaces(db).find((s) => s.id === r.spaceId)!;
  expect(space).toMatchObject({ name: "Investing", kind: "markets", private: true, goal: "Long-term TFSA investing: portfolio health, research and ideas." });
  const w = listWatchlist(db, r.spaceId);
  expect(w.map((x) => x.key)).toEqual(KEYS);
  expect(w.filter((x) => x.exchange === "TSX").map((x) => x.key)).toEqual(["ATZ.TO", "VFV.TO", "XEQT.TO"]);
  expect(w.filter((x) => x.exchange === "US")).toHaveLength(10);
  expect(w.find((x) => x.key === "RKLB")!.name).toBe("Rocket Lab");
  expect(getSetting(db, "investing.seeded")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(listActivity(db, { spaceId: r.spaceId }).map((a) => a.message)).toContain("Added your 13 tickers to the Investing watchlist.");
  expect(seedInvesting(db)).toEqual({ spaceId: r.spaceId, created: false, added: 0 });
});

test("an existing Investing space keeps what it has", () => {
  const s = createSpace(db, { name: "Investing", kind: "markets", goal: "mine" });
  addToWatchlist(db, s.id, { symbol: "SPY", exchange: "US" });
  expect(seedInvesting(db)).toEqual({ spaceId: s.id, created: false, added: 12 });
});

test("seedOnBoot only ever runs on the real DB, and only once", () => {
  seedOnBoot(db);
  expect(listSpaces(db)).toHaveLength(0);
  const saved = process.env.ATRIUM_HOME;
  delete process.env.ATRIUM_HOME;
  try {
    const real = openDb(join(home.home, "pretend-real.db"));
    setSetting(real, "investing.seeded", "2026-11-05T00:00:00.000Z");
    seedOnBoot(real);
    expect(listSpaces(real)).toHaveLength(0);
    real.query("DELETE FROM settings WHERE key = 'investing.seeded'").run();
    seedOnBoot(real);
    expect(listSpaces(real).map((s) => s.name)).toEqual(["Investing"]);
    real.close();
  } finally {
    process.env.ATRIUM_HOME = saved;
  }
});
