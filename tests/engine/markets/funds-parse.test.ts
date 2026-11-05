import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { parseIshares } from "../../../src/engine/markets/funds/parse-ishares";
import { parseSsga } from "../../../src/engine/markets/funds/parse-ssga";
import { normalizeSector } from "../../../src/engine/markets/funds/sectors";
import { FundFileError } from "../../../src/engine/markets/funds/types";
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
