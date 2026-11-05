import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../../src/engine/db";
import { createSpace } from "../../../src/engine/spaces";
import { addHolding, listHoldings, removeHolding, replaceImported } from "../../../src/engine/markets/holdings";
import { listIdeas, setIdea } from "../../../src/engine/markets/ideas";
import { addToWatchlist } from "../../../src/engine/markets/watchlist";
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

const row = (symbol: string) => ({ account: "TFSA", symbol, exchange: "US" as const, name: symbol, quantity: 1, bookValue: 1, currency: "USD" as const });
const stage = (key: string) => listIdeas(db, spaceId).find((i) => i.key === key);

test("holdings move ideas to owned, and to sold when they're gone", () => {
  replaceImported(db, spaceId, "wealthsimple_holdings", ["TFSA"], [row("NOW"), row("RKLB")]);
  expect(stage("NOW")).toMatchObject({ stage: "owned", stored: true });
  replaceImported(db, spaceId, "wealthsimple_holdings", ["TFSA"], [row("RKLB")]);
  expect(stage("NOW")!.stage).toBe("sold");
  expect(stage("RKLB")!.stage).toBe("owned");
  const h = addHolding(db, spaceId, row("SOFI"));
  expect(stage("SOFI")!.stage).toBe("owned");
  removeHolding(db, h.id);
  expect(stage("SOFI")!.stage).toBe("sold");
  expect(listHoldings(db, spaceId).map((x) => x.key)).toEqual(["RKLB"]);
});

test("watchlist keys without an idea are implicitly watching; ideas can be staged and noted", () => {
  addToWatchlist(db, spaceId, { symbol: "QBTS", exchange: "US" });
  expect(stage("QBTS")).toMatchObject({ stage: "watching", stored: false, note: "" });
  const i = setIdea(db, spaceId, "QBTS", { stage: "researching", note: "Q3 call" });
  expect(i).toMatchObject({ key: "QBTS", stage: "researching", note: "Q3 call", stored: true });
  setIdea(db, spaceId, "QBTS", { note: "Q3 call, margins" });
  expect(stage("QBTS")).toMatchObject({ stage: "researching", note: "Q3 call, margins" });
  expect(() => setIdea(db, spaceId, "QBTS", { stage: "maybe" as never })).toThrow("Pick watching, researching, owned or sold.");
  addHolding(db, spaceId, row("NOW"));
  expect(listIdeas(db, spaceId).map((x) => x.key)).toEqual(["QBTS", "NOW"]);
});
