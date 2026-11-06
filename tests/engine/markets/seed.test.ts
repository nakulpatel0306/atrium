import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { openDb } from "../../../src/engine/db";
import { listActivity } from "../../../src/engine/events";
import { getSetting, setSetting } from "../../../src/engine/settings";
import { createSpace, listSpaces } from "../../../src/engine/spaces";
import { addMetaOnce, INVESTING_TICKERS, META_ADDED, seedInvesting, seedOnBoot } from "../../../src/engine/markets/seed";
import { createList, ensureDefaultList, listItems } from "../../../src/engine/markets/lists";
import { addToWatchlist, listWatchlist, removeFromWatchlist } from "../../../src/engine/markets/watchlist";
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

const KEYS = ["ATZ.TO", "NOW", "TSLA", "AMZN", "MARS", "DRAM", "SPY", "VFV.TO", "QQQ", "QBTS", "SOFI", "RKLB", "XEQT.TO", "META"];

test("seedInvesting adds 14 tickers including META", () => {
  expect(INVESTING_TICKERS.map((t) => t.key)).toEqual(KEYS);
  const r = seedInvesting(db);
  expect(r).toMatchObject({ created: true, added: 14 });
  const space = listSpaces(db).find((s) => s.id === r.spaceId)!;
  expect(space).toMatchObject({ name: "Investing", kind: "markets", private: true, goal: "Long-term TFSA investing: portfolio health, research and ideas." });
  const w = listWatchlist(db, r.spaceId);
  expect(w.map((x) => x.key)).toEqual(KEYS);
  expect(w.filter((x) => x.exchange === "TSX").map((x) => x.key)).toEqual(["ATZ.TO", "VFV.TO", "XEQT.TO"]);
  expect(w.filter((x) => x.exchange === "US")).toHaveLength(11);
  expect(w.find((x) => x.key === "RKLB")!.name).toBe("Rocket Lab");
  expect(getSetting(db, "investing.seeded")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(listActivity(db, { spaceId: r.spaceId }).map((a) => a.message)).toContain("Added your 14 tickers to the Investing watchlist.");
  expect(seedInvesting(db)).toEqual({ spaceId: r.spaceId, created: false, added: 0 });
});

test("an existing Investing space keeps what it has", () => {
  const s = createSpace(db, { name: "Investing", kind: "markets", goal: "mine" });
  addToWatchlist(db, s.id, { symbol: "SPY", exchange: "US" });
  expect(seedInvesting(db)).toEqual({ spaceId: s.id, created: false, added: 13 });
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

const metaLogs = (spaceId: string) => listActivity(db, { spaceId }).filter((a) => a.message === "Added META to your Holdings list.");
const investing = () => {
  const s = createSpace(db, { name: "Investing", kind: "markets", goal: "g" });
  for (const k of ["AMZN", "NOW"]) addToWatchlist(db, s.id, { symbol: k, exchange: "US" });
  return s.id;
};

test("addMetaOnce adds META to the Investing space's first list and logs once", () => {
  const id = investing();
  createList(db, id, "Ideas");
  expect(addMetaOnce(db)).toBe("added");
  const holdings = ensureDefaultList(db, id);
  expect(listItems(db, holdings.id).map((i) => i.key)).toEqual(["AMZN", "NOW", "META"]);
  expect(metaLogs(id)).toHaveLength(1);
  expect(getSetting(db, META_ADDED)).not.toBeNull();
});

test("a second call is done_before and changes nothing", () => {
  const id = investing();
  addMetaOnce(db);
  expect(addMetaOnce(db)).toBe("done_before");
  expect(listWatchlist(db, id).filter((w) => w.key === "META")).toHaveLength(1);
  expect(metaLogs(id)).toHaveLength(1);
});

test("if Nakul removed META after it was added, it stays removed", () => {
  const id = investing();
  addMetaOnce(db);
  removeFromWatchlist(db, id, "META");
  expect(addMetaOnce(db)).toBe("done_before");
  expect(listWatchlist(db, id).map((w) => w.key)).toEqual(["AMZN", "NOW"]);
});

test("a second markets space named Ideas is untouched", () => {
  investing();
  const ideas = createSpace(db, { name: "Ideas", kind: "markets", goal: "g" });
  addToWatchlist(db, ideas.id, { symbol: "NVDA", exchange: "US" });
  addMetaOnce(db);
  expect(listWatchlist(db, ideas.id).map((w) => w.key)).toEqual(["NVDA"]);
});

test("with META already present it reports present without logging", () => {
  const id = investing();
  addToWatchlist(db, id, { symbol: "META", exchange: "US" });
  expect(addMetaOnce(db)).toBe("present");
  expect(metaLogs(id)).toHaveLength(0);
  expect(getSetting(db, META_ADDED)).not.toBeNull();
});

test("with no Investing space it sets no flag", () => {
  expect(addMetaOnce(db)).toBe("no_space");
  expect(getSetting(db, META_ADDED)).toBeNull();
  investing();
  expect(addMetaOnce(db)).toBe("added");
});
