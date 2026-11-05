import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { ndxEstimate, parseNdxMembers } from "../../../src/engine/markets/funds/nasdaq100";
import { parseInvesco } from "../../../src/engine/markets/funds/parse-invesco";
import { parseIshares } from "../../../src/engine/markets/funds/parse-ishares";
import { parseRoundhill } from "../../../src/engine/markets/funds/parse-roundhill";
import { classifyLine } from "../../../src/engine/markets/funds/swaps";
import { parseSsga } from "../../../src/engine/markets/funds/parse-ssga";
import { normalizeSector } from "../../../src/engine/markets/funds/sectors";
import { FundFileError, type FundFile } from "../../../src/engine/markets/funds/types";
import { readXlsxRows } from "../../../src/engine/markets/funds/xlsx";

const DIR = join(import.meta.dir, "../../fixtures/markets/investing");
const text = (name: string) => readFileSync(join(DIR, name), "utf8");
const bytes = (name: string) => new Uint8Array(readFileSync(join(DIR, name)));
const sum = (ws: number[]) => ws.reduce((a, b) => a + b, 0);

test("readXlsxRows keeps blank cells in place", () => {
  const book = zipSync({
    "xl/sharedStrings.xml": strToU8(
      '<?xml version="1.0"?><sst><si><t>Name</t></si><si><r><t>Wei</t></r><r><t>ght</t></r></si><si><t>AT&amp;T</t></si></sst>',
    ),
    "xl/worksheets/sheet1.xml": strToU8(
      '<?xml version="1.0"?><worksheet><sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="inlineStr"><is><t>T</t></is></c><c r="C2"><v>0.5</v></c></row>' +
        "</sheetData></worksheet>",
    ),
  });
  expect(readXlsxRows(book)).toEqual([
    ["Name", "", "Weight"],
    ["AT&T", "T", "0.5"],
  ]);
  expect(() => readXlsxRows(new Uint8Array([1, 2, 3, 4, 5]))).toThrow(new FundFileError("That holdings file isn't a spreadsheet Atrium can read."));
});

test("normalizeSector maps issuer spellings to GICS", () => {
  expect(normalizeSector("Information Technology")).toBe("Information Technology");
  expect(normalizeSector("Communication")).toBe("Communication Services");
  expect(normalizeSector("Consumer Discretionary")).toBe("Consumer Discretionary");
  expect(normalizeSector("Cash and/or Derivatives")).toBeNull();
  expect(normalizeSector("-")).toBeNull();
  expect(normalizeSector(null)).toBeNull();
});

test("parseIshares reads XEQT through iShares' own look-through table", () => {
  const f = parseIshares(text("ishares-xeqt.csv"), "XEQT.TO", "ishares-ca");
  expect(f.asOf).toBe("2026-11-04");
  expect(f.source).toBe("ishares-ca");
  expect(f.lines.length).toBeGreaterThan(1500);
  // The fixture keeps only lines iShares shows at 0.01% or more, so a few percent of the fund is left out.
  expect(sum(f.lines.map((l) => l.weight))).toBeGreaterThan(0.9);
  expect(sum(f.lines.map((l) => l.weight))).toBeLessThan(1.01);
  const aapl = f.lines.find((l) => l.ticker === "AAPL")!;
  expect(Math.abs(aapl.weight - 0.0306)).toBeLessThan(0.001);
  expect(aapl).toMatchObject({ key: "AAPL", kind: "stock", sector: "Information Technology", country: "United States", currency: "USD" });
  expect(f.lines.find((l) => l.ticker === "ATZ")).toMatchObject({ key: "ATZ.TO", sector: "Consumer Discretionary", country: "Canada", currency: "CAD" });
  expect(f.lines.find((l) => l.name === "CAD CASH")!.kind).toBe("cash");
  expect(f.note).toContain("look-through");
});

test("a single-table iShares file lists its sleeves as funds", () => {
  const all = text("ishares-xeqt.csv").split("\n");
  const second = all.findIndex((l, i) => i > 0 && l.startsWith("Fund Holdings as of"));
  const f = parseIshares(all.slice(0, second).join("\n"), "XEQT.TO", "ishares-ca");
  const xtot = f.lines.find((l) => l.ticker === "XTOT")!;
  expect(xtot).toMatchObject({ key: "XTOT.TO", kind: "fund" });
  expect(Math.abs(xtot.weight - 0.3061)).toBeLessThan(0.001);
  expect(f.lines.find((l) => l.ticker === "ITOT")).toMatchObject({ key: "ITOT", kind: "fund", currency: "USD" });
  expect(f.lines.filter((l) => l.kind === "fund")).toHaveLength(5);
  expect(f.note).toBeNull();
});

test("parseSsga reads SPY's spreadsheet", () => {
  const f = parseSsga(bytes("ssga-spy.xlsx"), "SPY");
  expect(f.lines.length).toBeGreaterThanOrEqual(490);
  expect(f.asOf).toBe("2026-11-04");
  const top = [...f.lines].sort((a, b) => b.weight - a.weight)[0]!;
  expect(["NVDA", "MSFT", "AAPL"]).toContain(top.ticker!);
  expect(f.lines.some((l) => l.sector === "Cash and/or Derivatives")).toBe(false);
  expect(sum(f.lines.map((l) => l.weight))).toBeGreaterThan(0.99);
  expect(sum(f.lines.map((l) => l.weight))).toBeLessThan(1.01);
  expect(top).toMatchObject({ country: "United States", currency: "USD", kind: "stock" });
});

test("a holdings file without its header row has changed shape", () => {
  const csv = text("ishares-xeqt.csv")
    .split("\n")
    .filter((l) => !l.startsWith("Ticker,"))
    .join("\n");
  expect(() => parseIshares(csv, "XEQT.TO", "ishares-ca")).toThrow(new FundFileError("The XEQT.TO holdings file has changed shape; Atrium couldn't find its holdings table."));
  expect(() => parseIshares("<html><body>Error</body></html>", "XEQT.TO", "ishares-ca")).toThrow(FundFileError);
});

const roundhill = () => text("roundhill-holdings.csv");

test("MARS holdings come from Roundhill's daily file", () => {
  const f = parseRoundhill(roundhill(), "MARS");
  expect(f.source).toBe("roundhill");
  expect(f.asOf).toBe("2026-11-04");
  expect(Math.abs(f.lines.find((l) => l.ticker === "RKLB")!.weight - 0.0886)).toBeLessThan(0.005);
  expect(Math.abs(f.lines.find((l) => l.ticker === "SPCX")!.weight - 0.2576)).toBeLessThan(0.005);
  expect(f.lines.find((l) => l.ticker === "RKLB")).toMatchObject({ key: "RKLB", kind: "stock", country: "United States" });
  expect(f.lines.find((l) => l.ticker === "9412.JP")).toMatchObject({ key: null, country: "Japan", kind: "stock" });
  // No swaps, so MARS's cash is just cash.
  expect(f.lines.some((l) => l.kind === "cash")).toBe(true);
  expect(f.note).toBeNull();
  expect(() => parseRoundhill(roundhill(), "NOPE")).toThrow(FundFileError);
});

test("DRAM swaps resolve, collateral dropped", () => {
  const f = parseRoundhill(roundhill(), "DRAM");
  const mu = f.lines.filter((l) => l.ticker === "MU");
  expect(mu.some((l) => l.via === "swap" && l.kind === "stock" && l.key === "MU")).toBe(true);
  expect(mu.some((l) => l.via === null)).toBe(true);
  expect(f.lines.find((l) => l.via === "swap" && /hynix/i.test(l.name))).toMatchObject({ ticker: "000660.KS", key: null, country: "South Korea" });
  expect(f.lines.some((l) => l.kind === "cash")).toBe(false);
  expect(Math.abs(sum(f.lines.map((l) => l.weight)) - 1)).toBeLessThan(0.001);
  expect(f.note).toBe("Treasury bills and cash back DRAM's swaps; they aren't counted as extra exposure.");
});

test("an unknown swap says so", () => {
  expect(classifyLine("ACME MEMORY CORP-SWAP-GOLD-L", "X123 TRS 052427 GS")).toEqual({ kind: "other", swap: true, name: "Swap, underlying not recognised: ACME MEMORY CORP-SWAP-GOLD-L" });
  expect(classifyLine("United States Treasury Bill 12/03/2026", "912797VA2").kind).toBe("cash");
  expect(classifyLine("Micron Technology Inc", "MU")).toEqual({ kind: "stock", swap: false });
  const csv = [
    "Date,Account,StockTicker,CUSIP,SecurityName,Shares,Price,MarketValue,Weightings,NetAssets,SharesOutstanding,CreationUnits,MoneyMarketFlag",
    "11/05/2026,TEST,X1 TRS 1 GS,X1 TRS 1 GS,ACME MEMORY CORP-SWAP-GOLD-L,1,1,1,60.00%,1,1,1,",
    "11/05/2026,TEST,MU,595112103,Micron Technology Inc,1,1,1,40.00%,1,1,1,",
  ].join("\n");
  const f = parseRoundhill(csv, "TEST");
  expect(f.lines.find((l) => l.kind === "other")!.name).toBe("Swap, underlying not recognised: ACME MEMORY CORP-SWAP-GOLD-L");
});

test("a fund whose non-cash lines are 60% keeps its cash", () => {
  const csv = [
    "Date,Account,StockTicker,CUSIP,SecurityName,Shares,Price,MarketValue,Weightings,NetAssets,SharesOutstanding,CreationUnits,MoneyMarketFlag",
    "11/05/2026,TEST,595112103 TRS 1 GS,595112103 TRS 1 GS,MICRON TECHNOLOGY INC SWAP,1,1,1,60.00%,1,1,1,",
    "11/05/2026,TEST,912797VA2,912797VA2,United States Treasury Bill 12/03/2026,1,1,1,40.00%,1,1,1,",
  ].join("\n");
  const f = parseRoundhill(csv, "TEST");
  expect(f.lines.map((l) => [l.kind, l.weight])).toEqual([["stock", 0.6], ["cash", 0.4]]);
  expect(f.note).toBeNull();
});

test("parseInvesco reads QQQ's file", () => {
  const f = parseInvesco(text("invesco-qqq.csv"));
  expect(f).toMatchObject({ fund: "QQQ", source: "invesco", asOf: "2026-11-04" });
  expect(sum(f.lines.map((l) => l.weight))).toBeGreaterThan(0.99);
  expect(sum(f.lines.map((l) => l.weight))).toBeLessThan(1.01);
  expect(f.lines[0]).toMatchObject({ ticker: "NVDA", key: "NVDA", weight: 0.091 });
});

test("the Nasdaq-100 estimate weights members by their S&P 500 weights", () => {
  const spy: FundFile = {
    fund: "SPY",
    source: "ssga",
    asOf: "2026-11-04",
    note: null,
    lines: [
      { ticker: "AAPL", key: "AAPL", name: "APPLE INC", weight: 0.07, kind: "stock", sector: null, country: "United States", currency: "USD", via: null },
      { ticker: "MSFT", key: "MSFT", name: "MICROSOFT", weight: 0.06, kind: "stock", sector: null, country: "United States", currency: "USD", via: null },
      { ticker: "JPM", key: "JPM", name: "JPMORGAN", weight: 0.03, kind: "stock", sector: null, country: "United States", currency: "USD", via: null },
    ],
  };
  const f = ndxEstimate(["AAPL", "MSFT", "ASML"], spy);
  expect(f).toMatchObject({ fund: "QQQ", source: "ndx-estimate", asOf: "2026-11-04" });
  expect(f.lines.map((l) => [l.ticker, l.weight])).toEqual([["AAPL", 0.07 / 0.13], ["MSFT", 0.06 / 0.13]]);
  expect(f.note).toBe("Estimate: Nasdaq-100 members (from Wikipedia, CC BY-SA) weighted by their S&P 500 weights. Not counted: ASML.");
});

test("parseNdxMembers reads the components table", () => {
  const m = parseNdxMembers(text("wikipedia-nasdaq100.json"));
  expect(m.length).toBeGreaterThanOrEqual(95);
  expect(m.length).toBeLessThanOrEqual(110);
  expect(m).toContain("AAPL");
  expect(m).toContain("NVDA");
  expect(() => parseNdxMembers("{}")).toThrow(FundFileError);
});
