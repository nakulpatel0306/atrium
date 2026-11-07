import { parseCsv } from "../csv";
import { normalizeSector } from "./sectors";
import { changedShape, isoDate, num, sumWeights, type FundFile, type FundLine } from "./types";

// Invesco's documented holdings download: Fund Ticker, Security Identifier, Holding Ticker, …, Weight, Name, …, Date.
export function parseInvesco(csv: string): FundFile {
  const rows = parseCsv(csv);
  const header = (rows[0] ?? []).map((h) => h.trim());
  const col = (n: string) => header.indexOf(n);
  const c = { ticker: col("Holding Ticker"), weight: col("Weight"), name: col("Name"), date: col("Date"), sector: col("Sector") };
  if (c.ticker < 0 || c.weight < 0 || c.name < 0) throw changedShape("QQQ");
  const data = rows.slice(1).filter((r) => (r[c.ticker] ?? "").trim());
  const lines: FundLine[] = data.map((r) => {
    const t = r[c.ticker]!.trim().toUpperCase();
    return { ticker: t, key: t, name: (r[c.name] ?? "").trim(), weight: num(r[c.weight]) / 100, kind: "stock", sector: c.sector >= 0 ? normalizeSector(r[c.sector] ?? null) : null, country: "United States", currency: "USD", via: null };
  });
  const asOf = isoDate(data[0]?.[c.date] ?? "");
  const total = sumWeights(lines);
  if (!asOf || !(total >= 0.9 && total <= 1.1)) throw changedShape("QQQ");
  return { fund: "QQQ", source: "invesco", asOf, lines, note: null };
}
