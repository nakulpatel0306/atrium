import { normalizeSector } from "./sectors";
import { changedShape, isoDate, num, sumWeights, type FundFile, type FundLine } from "./types";
import { readXlsxRows } from "./xlsx";

const CASH = /CASH|U\.S\. DOLLAR|MONEY MARKET/i;

// SSGA's daily holdings spreadsheet: a few label rows ("Holdings:" "As of 04-Nov-2026"), then a table headed
// Name, Ticker, Identifier, SEDOL, Weight, Sector, … with weights in percent.
export function parseSsga(bytes: Uint8Array, fund: string): FundFile {
  const rows = readXlsxRows(bytes);
  const asOfRow = rows.find((r) => (r[0] ?? "").trim() === "Holdings:");
  const asOf = isoDate((asOfRow?.[1] ?? "").replace(/^As of /i, ""));
  const h = rows.findIndex((r) => r.includes("Name") && r.includes("Ticker") && r.includes("Weight"));
  if (h < 0 || !asOf) throw changedShape(fund);
  const header = rows[h]!;
  const col = (n: string) => header.indexOf(n);
  const lines: FundLine[] = [];
  for (const r of rows.slice(h + 1)) {
    const name = (r[col("Name")] ?? "").trim();
    const weight = num(r[col("Weight")]);
    // The table ends at the first row without a name and weight (the disclaimers follow).
    if (!name || !Number.isFinite(weight)) break;
    const raw = (r[col("Ticker")] ?? "").trim();
    const cash = raw === "CASH_USD" || raw === "-" || !raw || CASH.test(name);
    lines.push({
      ticker: cash ? null : raw,
      key: cash ? null : raw.replace(/\s+/g, ".").toUpperCase(),
      name,
      weight: weight / 100,
      kind: cash ? "cash" : "stock",
      sector: cash ? null : normalizeSector(col("Sector") >= 0 ? (r[col("Sector")] ?? null) : null),
      country: "United States",
      currency: "USD",
      via: null,
    });
  }
  const total = sumWeights(lines);
  if (total < 0.9 || total > 1.1) throw changedShape(fund);
  return { fund, source: "ssga", asOf, lines, note: null };
}
