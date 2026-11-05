import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../../src/engine/db";
import type { Position } from "../../../src/engine/markets/health";
import type { Sourced } from "../../../src/engine/markets/sourced";
import { addEntry, incomeTtm, isTfsa, listEntries, removeEntry, roomStatus, setRoom, withholdingNote } from "../../../src/engine/markets/tfsa";
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

const US_TFSA = "15% US withholding tax is taken from these dividends in a TFSA and can't be recovered.";
const NOW = Date.parse("2026-11-05T16:00:00Z");
const fx: Sourced = { value: 1.4, source: "Bank of Canada · Nov 4", asOf: NOW, tone: "official" };
const pos = (key: string, account: string, quantity: number): Position => ({
  key,
  account,
  quantity,
  price: null,
  prevClose: null,
  listingCcy: key.endsWith(".TO") ? "CAD" : "USD",
  bookValue: null,
  bookCcy: "USD",
  bookValueCad: null,
  kind: "etf",
});

test("withholding notes for a TFSA", () => {
  expect(isTfsa("TFSA")).toBe(true);
  expect(isTfsa("Wealthsimple tfsa")).toBe(true);
  expect(withholdingNote({ key: "SPY", account: "TFSA", listingCcy: "USD", ttmDividend: 7, usExposure: 1 })).toBe(US_TFSA);
  expect(withholdingNote({ key: "VFV.TO", account: "TFSA", listingCcy: "CAD", ttmDividend: 0, usExposure: 1 })).toBe(
    "About 15% US withholding is taken inside the fund before distributions; it can't be recovered in a TFSA.",
  );
  expect(withholdingNote({ key: "SPY", account: "RRSP", listingCcy: "USD", ttmDividend: 7, usExposure: 1 })).toBeNull();
  expect(withholdingNote({ key: "TSLA", account: "TFSA", listingCcy: "USD", ttmDividend: 0, usExposure: 1 })).toBeNull();
});

test("dividend income over the last year, net of withholding in a TFSA", () => {
  const put = db.query("INSERT INTO market_dividends (key, ex_date, amount, source) VALUES ('SPY', ?, 1.8, 'tiingo')");
  for (const d of ["2025-12-19", "2026-03-20", "2026-06-18", "2026-09-19", "2025-09-20"]) put.run(d);
  const r = incomeTtm(db, [pos("SPY", "TFSA", 10), pos("ATZ.TO", "TFSA", 5)], fx, NOW);
  expect(r.rows).toEqual([{ key: "SPY", gross: expect.closeTo(72, 9), net: expect.closeTo(61.2, 9), ccy: "USD", source: "Tiingo dividends · last 12 months", note: US_TFSA }]);
  expect(r.totalNetCad!.value).toBeCloseTo(61.2 * 1.4, 9);
  expect(r.totalNetCad!.source).toContain("Tiingo dividends · last 12 months");
  expect(r.unavailable).toEqual([{ key: "ATZ.TO", reason: "No free source for ATZ.TO distributions yet." }]);
  expect(incomeTtm(db, [pos("SPY", "TFSA", 10)], null, NOW).totalNetCad).toBeNull();
});

test("contribution room from the numbers Nakul enters", () => {
  expect(roomStatus(db, 2026).text).toBe("Enter your room from CRA My Account (it isn't fetched).");
  setRoom(db, 2026, 7000);
  addEntry(db, { date: "2026-01-15", kind: "contribution", amount: 5000 });
  addEntry(db, { date: "2026-03-02", kind: "contribution", amount: 1500 });
  addEntry(db, { date: "2026-05-10", kind: "withdrawal", amount: 1000 });
  addEntry(db, { date: "2025-12-30", kind: "contribution", amount: 999 });
  expect(roomStatus(db, 2026)).toEqual({
    year: 2026,
    roomJan1: 7000,
    contributed: 6500,
    withdrawn: 1000,
    remaining: 500,
    addsBackNextYear: 1000,
    over: 0,
    text: "CA$500.00 of room left for 2026.",
  });
  const id = addEntry(db, { date: "2026-08-01", kind: "contribution", amount: 800, note: "oops" });
  expect(roomStatus(db, 2026)).toMatchObject({ remaining: -300, over: 300, text: "Over by CA$300.00: CRA charges 1% a month on the excess until it's withdrawn." });
  expect(listEntries(db, 2026)).toHaveLength(4);
  removeEntry(db, id);
  expect(roomStatus(db, 2026).remaining).toBe(500);
  expect(() => addEntry(db, { date: "2026-08-01", kind: "contribution", amount: -5 })).toThrow("The amount must be more than zero.");
  expect(() => addEntry(db, { date: "Aug 1", kind: "contribution", amount: 5 })).toThrow("Use a date like 2026-08-01.");
  expect(() => setRoom(db, 2026, -1)).toThrow("The room can't be negative.");
});

test("TFSA and notes edits tell the dashboard to refresh", async () => {
  const { bus } = await import("../../../src/engine/events");
  const { saveNotes } = await import("../../../src/engine/markets/research");
  let changed = 0;
  const off = bus.on((e) => void (e.type === "changed" && changed++));
  setRoom(db, 2026, 100);
  const id = addEntry(db, { date: "2026-01-02", kind: "contribution", amount: 5 });
  removeEntry(db, id);
  db.exec("INSERT INTO spaces (id, name, kind, color, created_at, updated_at) VALUES ('spc_x', 'X', 'markets', 'c', 1, 1)");
  saveNotes(db, "spc_x", "NOW", { thesis: "t" });
  off();
  expect(changed).toBe(4);
});
