import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../../src/engine/db";
import { createSpace } from "../../../src/engine/spaces";
import {
  addToList,
  createList,
  DEFAULT_LIST_NAME,
  deleteList,
  ensureDefaultList,
  listItems,
  listLists,
  MAX_LISTS,
  removeFromList,
  renameList,
} from "../../../src/engine/markets/lists";
import { addToWatchlist, listWatchlist, removeFromWatchlist } from "../../../src/engine/markets/watchlist";
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

const US = (symbol: string) => ({ symbol, exchange: "US" as const });

test("create, rename, delete with plain refusals", () => {
  const holdings = ensureDefaultList(db, spaceId);
  expect(holdings).toMatchObject({ name: DEFAULT_LIST_NAME, position: 0, spaceId });
  expect(ensureDefaultList(db, spaceId).id).toBe(holdings.id);
  expect(() => createList(db, spaceId, "  ")).toThrow("Name the list, like Holdings or Ideas.");
  expect(() => createList(db, spaceId, "x".repeat(41))).toThrow("Keep list names under 40 characters.");
  expect(() => createList(db, spaceId, "holdings")).toThrow('You already have a list called "holdings".');
  const ideas = createList(db, spaceId, " Ideas ");
  expect(ideas).toMatchObject({ name: "Ideas", position: 1 });
  expect(renameList(db, ideas.id, "Maybe").name).toBe("Maybe");
  expect(() => renameList(db, ideas.id, "HOLDINGS")).toThrow('You already have a list called "HOLDINGS".');
  expect(renameList(db, ideas.id, "maybe").name).toBe("maybe");
  for (let i = listLists(db, spaceId).length; i < MAX_LISTS; i++) createList(db, spaceId, `L${i}`);
  expect(() => createList(db, spaceId, "One more")).toThrow("That's 20 lists, the most Atrium keeps. Delete one first.");
  for (const l of listLists(db, spaceId).slice(1)) deleteList(db, l.id);
  expect(() => deleteList(db, holdings.id)).toThrow("Keep at least one list. Make a new one before deleting this.");
  expect(listLists(db, spaceId).map((l) => l.name)).toEqual(["Holdings"]);
});

test("deleting a list removes its items only", () => {
  const a = ensureDefaultList(db, spaceId);
  const b = createList(db, spaceId, "Ideas");
  addToList(db, a.id, US("AMZN"));
  addToList(db, b.id, US("AMZN"));
  addToList(db, b.id, US("NVDA"));
  deleteList(db, b.id);
  expect(listItems(db, a.id).map((i) => i.key)).toEqual(["AMZN"]);
  expect(db.query("SELECT COUNT(*) AS n FROM market_watchlist").get()).toEqual({ n: 1 });
});

test("listWatchlist is the union without duplicates", () => {
  const a = ensureDefaultList(db, spaceId);
  const b = createList(db, spaceId, "Ideas");
  addToList(db, a.id, US("AMZN"));
  addToList(db, b.id, US("NVDA"));
  addToList(db, b.id, US("AMZN"));
  expect(listWatchlist(db, spaceId).map((i) => i.key)).toEqual(["AMZN", "NVDA"]);
  removeFromList(db, b.id, "AMZN");
  expect(listItems(db, b.id).map((i) => i.key)).toEqual(["NVDA"]);
});

test("addToWatchlist goes to the first list, creating Holdings if none", () => {
  expect(listLists(db, spaceId)).toEqual([]);
  addToWatchlist(db, spaceId, US("AMZN"), "Amazon");
  const lists = listLists(db, spaceId);
  expect(lists.map((l) => l.name)).toEqual(["Holdings"]);
  expect(listItems(db, lists[0]!.id)).toMatchObject([{ key: "AMZN", name: "Amazon" }]);
});

test("removeFromWatchlist removes from every list", () => {
  const a = ensureDefaultList(db, spaceId);
  const b = createList(db, spaceId, "Ideas");
  addToList(db, a.id, US("AMZN"));
  addToList(db, b.id, US("AMZN"));
  removeFromWatchlist(db, spaceId, "AMZN");
  expect(listWatchlist(db, spaceId)).toEqual([]);
});
