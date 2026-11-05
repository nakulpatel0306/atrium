import { parseCsv } from "../csv";
import { normalizeSector } from "./sectors";
import { changedShape, isoDate, num, sumWeights, type FundFile, type FundLine, type LineKind } from "./types";

// US exchanges as iShares names them; anything else that isn't Toronto is a foreign listing with no Atrium key.
const US_EXCHANGES = /^(NASDAQ|New York Stock Exchange|NYSE|Cboe|BATS|Nyse Mkt)/i;
const FUND_NAME = /\bISHARES\b|\bETF\b|\bINDEX FUND\b/i;

export function listingKey(ticker: string, exchange: string): string | null {
  if (!ticker || ticker === "-") return null;
  const t = ticker.trim().toUpperCase();
  if (/^Toronto Stock Exchange/i.test(exchange)) return `${t.replace(/\s+/g, ".")}.TO`;
  if (/^TSX Venture/i.test(exchange)) return `${t}.V`;
  if (US_EXCHANGES.test(exchange)) return t.replace(/\s+/g, ".");
  return null;
}

type Table = { asOf: string | null; header: string[]; rows: string[][] };

// iShares files have a preamble, then one or more tables, each after its own "Fund Holdings as of" line. A fund of
// funds lists its sleeves first and then iShares' own look-through of every company underneath.
function tables(csv: string): Table[] {
  const out: Table[] = [];
  let asOf: string | null = null;
  let cur: Table | null = null;
  for (const r of parseCsv(csv)) {
    const first = (r[0] ?? "").trim();
    if (/^Fund Holdings as of/i.test(first)) {
      asOf = isoDate(r[1] ?? "");
      cur = null;
      continue;
    }
    if (first === "Ticker" && r.includes("Weight (%)")) {
      cur = { asOf, header: r.map((h) => h.trim()), rows: [] };
      out.push(cur);
      continue;
    }
    if (!cur || r.length < cur.header.length / 2 || !first || first === " ") {
      if (cur && r.length < 3) cur = null;
      continue;
    }
    cur.rows.push(r);
  }
  return out;
}

function kindOf(assetClass: string, name: string): LineKind {
  if (/^(Cash|Money Market|Cash Collateral)/i.test(assetClass)) return "cash";
  if (/^(ETF|Fund)$/i.test(assetClass)) return "fund";
  if (/^Equity$/i.test(assetClass)) return FUND_NAME.test(name) ? "fund" : "stock";
  return "other";
}

export function parseIshares(csv: string, fund: string, source: "ishares-ca" | "ishares-us"): FundFile {
  const found = tables(csv).filter((t) => t.rows.length);
  const table = found.at(-1);
  if (!table) throw changedShape(fund);
  const col = (name: string) => table.header.indexOf(name);
  const c = {
    ticker: col("Ticker"),
    name: col("Name"),
    sector: col("Sector"),
    assetClass: col("Asset Class"),
    marketValue: col("Market Value"),
    weight: col("Weight (%)"),
    location: col("Location"),
    exchange: col("Exchange"),
    currency: col("Market Currency") >= 0 ? col("Market Currency") : col("Currency"),
  };
  if (c.ticker < 0 || c.name < 0 || c.weight < 0) throw changedShape(fund);
  const cell = (r: string[], i: number) => (i < 0 ? "" : (r[i] ?? "").trim());
  // The 2-dp Weight column rounds thousands of small holdings to 0.00; market values are exact. The fund's total is
  // the first table's (its sleeves), which the look-through table's values add up to.
  const values = table.rows.map((r) => num(cell(r, c.marketValue)));
  const mvCol = found[0]!.header.indexOf("Market Value");
  const fundTotal = found.length > 1 && mvCol >= 0 ? found[0]!.rows.reduce((a, r) => a + (num(r[mvCol]) || 0), 0) : 0;
  const totalValue = fundTotal > 0 ? fundTotal : values.reduce((a, v) => a + (Number.isFinite(v) ? v : 0), 0);
  const byValue = c.marketValue >= 0 && values.every((v) => Number.isFinite(v)) && totalValue > 0;
  const percentSum = table.rows.reduce((a, r) => a + (num(cell(r, c.weight)) || 0), 0) / 100;
  if (percentSum < 0.9 || percentSum > 1.1) throw changedShape(fund);
  const lines: FundLine[] = table.rows.map((r, i) => {
    const ticker = cell(r, c.ticker);
    const name = cell(r, c.name);
    const kind = kindOf(cell(r, c.assetClass), name);
    return {
      ticker: ticker && ticker !== "-" ? ticker : null,
      key: kind === "stock" || kind === "fund" ? listingKey(ticker, cell(r, c.exchange)) : null,
      name,
      weight: byValue ? values[i]! / totalValue : (num(cell(r, c.weight)) || 0) / 100,
      kind,
      sector: kind === "stock" ? normalizeSector(cell(r, c.sector)) : null,
      country: cell(r, c.location) || null,
      currency: cell(r, c.currency) || null,
      via: null,
    };
  });
  const total = sumWeights(lines);
  if (total < 0.9 || total > 1.1) throw changedShape(fund);
  const asOf = table.asOf ?? found[0]?.asOf;
  if (!asOf) throw changedShape(fund);
  return {
    fund,
    source,
    asOf,
    lines,
    note: found.length > 1 ? `iShares' own look-through of ${fund.replace(/\.TO$/, "")}'s underlying ETFs, weighted by market value.` : null,
  };
}
