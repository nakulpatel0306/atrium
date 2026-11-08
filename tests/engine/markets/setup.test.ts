import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../../src/engine/db";
import { createSpace, listSpaces } from "../../../src/engine/spaces";
import { setupInvesting } from "../../../src/engine/markets/setup";
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

test("a fresh engine has no spaces, and setup makes an empty private Investing space once", () => {
  expect(listSpaces(db)).toHaveLength(0);
  const a = setupInvesting(db);
  expect(a.created).toBe(true);
  expect(listSpaces(db).find((s) => s.id === a.spaceId)).toMatchObject({ name: "Investing", kind: "markets", private: true });
  expect(listWatchlist(db, a.spaceId)).toEqual([]);
  expect(setupInvesting(db)).toEqual({ spaceId: a.spaceId, created: false });
});

test("an existing Investing space keeps everything it has", () => {
  const s = createSpace(db, { name: "Investing", kind: "markets", goal: "mine" });
  addToWatchlist(db, s.id, { symbol: "SPY", exchange: "US" });
  expect(setupInvesting(db)).toEqual({ spaceId: s.id, created: false });
  expect(listWatchlist(db, s.id).map((w) => w.key)).toEqual(["SPY"]);
  expect(listSpaces(db).find((x) => x.id === s.id)!.goal).toBe("mine");
});
