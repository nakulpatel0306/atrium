import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../../src/engine/db";
import { createSpace } from "../../../src/engine/spaces";
import { advancedKey, advancedSpaces, anyAdvanced, isAdvanced, setAdvanced } from "../../../src/engine/markets/advanced";
import { getSetting } from "../../../src/engine/settings";
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

test("off by default, on per space", () => {
  const a = createSpace(db, { name: "Investing", kind: "markets", goal: "g" }).id;
  const b = createSpace(db, { name: "Ideas", kind: "markets", goal: "g" }).id;
  expect(advancedKey(a)).toBe(`markets.advanced.${a}`);
  expect(isAdvanced(db, a)).toBe(false);
  expect(isAdvanced(db, b)).toBe(false);
  expect(anyAdvanced(db)).toBe(false);
  setAdvanced(db, a, true);
  expect([...advancedSpaces(db)]).toEqual([a]);
  expect(isAdvanced(db, a)).toBe(true);
  setAdvanced(db, a, false);
  expect(getSetting(db, `markets.advanced.${a}`)).toBeNull();
  expect(anyAdvanced(db)).toBe(false);
});
