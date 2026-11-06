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
  expect(ko).toEqual({ account: "RRSP", symbol: "KO", exchange: "US", name: "Coca-Cola Company, The", quantity: 20, bookValue: 1150, bookValueCad: 1600, accountType: "RRSP", currency: "USD" });
  expect(p.accounts.sort()).toEqual(["RRSP", "TFSA"]);
  expect(p.guessed).toEqual([]);
});

test("holdings export keeps the CAD book value", () => {
  const p = previewImport(fixture("ws-holdings.csv"));
  expect(p.rows.map((r) => [r.symbol, r.bookValueCad])).toEqual([["SHOP", 1200], ["XEQT", 1500], ["KO", 1600], ["AAPL", 420]]);
  // The account's type is kept too, so a renamed TFSA is still known as one.
  expect(p.rows.map((r) => r.accountType)).toEqual(["TFSA", "TFSA", "RRSP", "TFSA"]);
  const a = previewImport(fixture("ws-activity.csv"));
  expect(a.rows.length).toBeGreaterThan(0);
  for (const r of a.rows) expect(r.bookValueCad).toBeNull();
  for (const r of a.rows) expect(r.accountType).toBeNull();
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
    { account: "TFSA", symbol: "SHOP", exchange: "TSX", name: "Shopify Inc.", quantity: 12, bookValue: 1720, bookValueCad: null, accountType: null, currency: "CAD" },
    { account: "RRSP", symbol: "XYZ", exchange: "TSX", name: "XYZ Resources", quantity: 100, bookValue: 1000, bookValueCad: null, accountType: null, currency: "CAD" },
    { account: "RRSP", symbol: "AAPL", exchange: "US", name: "Apple Inc.", quantity: 4, bookValue: 920, bookValueCad: null, accountType: null, currency: "USD" },
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
    { account: "Imported", symbol: "AAPL", exchange: "US", name: "", quantity: 10, bookValue: 1500, bookValueCad: null, accountType: null, currency: "USD" },
    { account: "Imported", symbol: "SHOP", exchange: "TSX", name: "", quantity: 5, bookValue: 700, bookValueCad: null, accountType: null, currency: "CAD" },
  ]);
});

test("bad quantities are listed, parenthesised numbers are negative", () => {
  const csv = "Symbol,Quantity,Book Value\nAAPL,ten,100\nMSFT,5,(20)\n";
  const p = previewImport(csv, { mapping: { symbol: 0, quantity: 1, bookValue: 2 } });
  expect(p.skipped).toEqual([{ line: 2, reason: "Quantity isn't a number." }]);
  expect(p.rows[0]!.bookValue).toBe(-20);
});

test("symbols that can't be looked up are skipped with a reason, in both formats", () => {
  const holdings = "Account Name,Symbol,Exchange,MIC,Security Type,Quantity,Book Value (Market),Market Price Currency\nTFSA,AB$CD,TSX,XTSE,EQUITY,5,10,CAD\nTFSA,SHOP,TSX,XTSE,EQUITY,1e999,10,CAD\nTFSA,RY,TSX,XTSE,EQUITY,2,1e999,CAD\n";
  const h = previewImport(holdings);
  expect(h.skipped).toEqual([
    { line: 2, reason: '"AB$CD" isn\'t a symbol Atrium can look up; add it by hand.' },
    { line: 3, reason: "Quantity isn't a number." },
  ]);
  expect(h.rows).toEqual([{ account: "TFSA", symbol: "RY", exchange: "TSX", name: "", quantity: 2, bookValue: null, bookValueCad: null, accountType: null, currency: "CAD" }]);
  const activity = "transaction_date,account_type,activity_type,activity_sub_type,symbol,currency,quantity,net_cash_amount\n2026-01-02,TFSA,Trade,BUY,BAD SYMBOL,CAD,5,-50\n2026-01-03,TFSA,Trade,BUY,SHOP,CAD,Infinity,-50\n2026-01-04,TFSA,Trade,BUY,RY,CAD,3,-30\n";
  const a = previewImport(activity);
  expect(a.skipped).toEqual([
    { line: 2, reason: '"BAD SYMBOL" isn\'t a symbol Atrium can look up; add it by hand.' },
    { line: 3, reason: "Quantity isn't a number." },
  ]);
  expect(a.rows.map((r) => [r.symbol, r.quantity])).toEqual([["RY", 3]]);
});

test("an import is capped at 500 positions", () => {
  const lines = Array.from({ length: 501 }, (_, i) => `TFSA,S${i},TSX,XTSE,EQUITY,1,1,CAD`);
  const p = previewImport(`Account Name,Symbol,Exchange,MIC,Security Type,Quantity,Book Value (Market),Market Price Currency\n${lines.join("\n")}\n`);
  expect(p.rows).toEqual([]);
  expect(p.warnings[0]).toBe("That file has 501 positions; Atrium imports at most 500 at a time. Export one account at a time.");
});
