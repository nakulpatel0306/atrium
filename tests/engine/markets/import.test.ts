import { expect, test } from "bun:test";
import { parseCsv } from "../../../src/engine/markets/csv";
import { previewImport } from "../../../src/engine/markets/import";
import { fixture } from "./fakes";

test("parseCsv handles quotes, CRLF, BOM and embedded newlines", () => {
  expect(parseCsv('a,"b,c","d ""q"""\r\n1,2,3')).toEqual([["a", "b,c", 'd "q"'], ["1", "2", "3"]]);
  expect(parseCsv("﻿x,y\n1,2\n")).toEqual([["x", "y"], ["1", "2"]]);
  expect(parseCsv('a,"line1\nline2"\n')).toEqual([["a", "line1\nline2"]]);
});

test("holdings fixture", () => {
  const p = previewImport(fixture("ws-holdings.csv"));
  expect(p.format).toBe("wealthsimple_holdings");
  expect(p.rows.map((r) => [r.symbol, r.exchange])).toEqual([["SHOP", "TSX"], ["XEQT", "TSX"], ["KO", "US"], ["AAPL", "NEO"]]);
  expect(p.skipped).toEqual([
    { line: 6, reason: "Options aren't tracked in v1." },
    { line: 7, reason: "Crypto isn't tracked in v1." },
    { line: 8, reason: 'Unknown exchange "MOON"; add it by hand.' },
  ]);
  expect(p.asOf).toBe("2026-01-28 23:02 GMT-05:00");
  const ko = p.rows.find((r) => r.symbol === "KO")!;
  expect(ko).toEqual({ account: "RRSP", symbol: "KO", exchange: "US", name: "Coca-Cola Company, The", quantity: 20, bookValue: 1150, currency: "USD" });
  expect(p.accounts.sort()).toEqual(["RRSP", "TFSA"]);
  expect(p.guessed).toEqual([]);
});

test("BOM/CRLF fixture parses the same", () => {
  expect(previewImport(fixture("ws-holdings-bom-crlf.csv")).rows).toEqual(previewImport(fixture("ws-holdings.csv")).rows);
});

test("activity exports become positions", () => {
  const a = previewImport(fixture("ws-activity.csv"));
  const b = previewImport(fixture("ws-activity-desc.csv"));
  expect(a.format).toBe("wealthsimple_activity");
  expect(b.rows).toEqual(a.rows);
  expect(a.rows).toEqual([
    { account: "TFSA", symbol: "SHOP", exchange: "TSX", name: "Shopify Inc.", quantity: 12, bookValue: 1720, currency: "CAD" },
    { account: "RRSP", symbol: "XYZ", exchange: "TSX", name: "XYZ Resources", quantity: 100, bookValue: 1000, currency: "CAD" },
    { account: "RRSP", symbol: "AAPL", exchange: "US", name: "Apple Inc.", quantity: 4, bookValue: 920, currency: "USD" },
  ]);
  expect(a.guessed).toEqual(expect.arrayContaining(["SHOP", "XYZ"]));
  expect(a.warnings).toContain("Positions from an activity export are only right if the file covers every trade since each account opened.");
  expect(a.warnings).toContain('1 rows like "Reorganization" weren\'t applied (splits and reorganisations); check those positions.');
  expect(a.asOf).toBe("2026-01-28 23:02 GMT-05:00");
  const o = previewImport(fixture("ws-activity.csv"), { exchangeOverrides: { XYZ: "NEO" } });
  expect(o.rows.find((r) => r.symbol === "XYZ")!.exchange).toBe("NEO");
  expect(o.guessed).not.toContain("XYZ");
});

test("an unknown CSV asks for columns, then uses them", () => {
  const p = previewImport(fixture("generic.csv"));
  expect(p.format).toBe("unknown");
  expect(p.rows).toEqual([]);
  expect(p.headers).toEqual(["Ticker", "Shares", "Cost"]);
  expect(p.warnings).toContain("Pick which columns hold the symbol and quantity.");
  const m = previewImport(fixture("generic.csv"), { mapping: { symbol: 0, quantity: 1, bookValue: 2 } });
  expect(m.rows).toEqual([
    { account: "Imported", symbol: "AAPL", exchange: "US", name: "", quantity: 10, bookValue: 1500, currency: "USD" },
    { account: "Imported", symbol: "SHOP", exchange: "TSX", name: "", quantity: 5, bookValue: 700, currency: "CAD" },
  ]);
});

test("bad quantities are listed, parenthesised numbers are negative", () => {
  const csv = "Symbol,Quantity,Book Value\nAAPL,ten,100\nMSFT,5,(20)\n";
  const p = previewImport(csv, { mapping: { symbol: 0, quantity: 1, bookValue: 2 } });
  expect(p.skipped).toEqual([{ line: 2, reason: "Quantity isn't a number." }]);
  expect(p.rows[0]!.bookValue).toBe(-20);
});
