import { parseCsv } from "../csv";
import { classifyLine } from "./swaps";
import { changedShape, FundFileError, isoDate, num, sumWeights, type FundFile, type FundLine } from "./types";

// Roundhill publishes one CSV a day for all its funds; its fund pages read the same file with JavaScript. A missing
// date answers 200 with an HTML page, so a reply only counts when it starts with the header.
export const ROUNDHILL_HEADER = "Date,Account,StockTicker";
export function roundhillUrl(isoDay: string): string {
  const [y, m, d] = isoDay.split("-");
  return `https://www.roundhillinvestments.com/assets/data/FilepointRoundhill.40RU.RU_Holdings_${m}${d}${y}.csv`;
}

// Bloomberg-style exchange suffixes on foreign lines ("000660 KS").
const SUFFIX: Record<string, { country: string; currency: string; yahooish: string }> = {
  KS: { country: "South Korea", currency: "KRW", yahooish: "KS" },
  KQ: { country: "South Korea", currency: "KRW", yahooish: "KQ" },
  TT: { country: "Taiwan", currency: "TWD", yahooish: "TW" },
  JP: { country: "Japan", currency: "JPY", yahooish: "JP" },
  IM: { country: "Italy", currency: "EUR", yahooish: "IM" },
  FP: { country: "France", currency: "EUR", yahooish: "FP" },
  GR: { country: "Germany", currency: "EUR", yahooish: "GR" },
  LN: { country: "United Kingdom", currency: "GBP", yahooish: "LN" },
  C1: { country: "China", currency: "CNY", yahooish: "C1" },
  C2: { country: "China", currency: "CNY", yahooish: "C2" },
  CH: { country: "China", currency: "CNY", yahooish: "CH" },
  HK: { country: "Hong Kong", currency: "HKD", yahooish: "HK" },
  CN: { country: "Canada", currency: "CAD", yahooish: "CN" },
  NO: { country: "Norway", currency: "NOK", yahooish: "NO" },
  SS: { country: "Sweden", currency: "SEK", yahooish: "SS" },
};

const dayBefore = (iso: string) => new Date(Date.parse(`${iso}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

export function parseRoundhill(csv: string, fund: string): FundFile {
  const rows = parseCsv(csv);
  const header = (rows[0] ?? []).map((h) => h.trim());
  const col = (n: string) => header.indexOf(n);
  const c = { date: col("Date"), account: col("Account"), ticker: col("StockTicker"), cusip: col("CUSIP"), name: col("SecurityName"), weight: col("Weightings"), mm: col("MoneyMarketFlag") };
  if (c.account < 0 || c.ticker < 0 || c.name < 0 || c.weight < 0) throw changedShape(fund);
  const mine = rows.slice(1).filter((r) => (r[c.account] ?? "").trim() === fund);
  if (!mine.length) throw new FundFileError(`Roundhill's holdings file doesn't list ${fund}.`);
  const fileDate = isoDate(mine[0]![c.date] ?? "");
  if (!fileDate) throw changedShape(fund);
  let swaps = false;
  const lines: FundLine[] = mine.map((r) => {
    const raw = (r[c.ticker] ?? "").trim();
    const name = (r[c.name] ?? "").trim();
    const weight = num(r[c.weight]) / 100;
    const cl = classifyLine(name, `${raw} ${r[c.cusip] ?? ""}`);
    const cash = cl.kind === "cash" || (r[c.mm] ?? "").trim() === "Y" || /^CASH/i.test((r[c.cusip] ?? "").trim());
    if (cl.swap) {
      swaps = true;
      const u = cl.resolved;
      return { ticker: u?.ticker ?? null, key: u?.key ?? null, name: u?.name ?? cl.name!, weight, kind: cl.kind, sector: null, country: u?.country ?? null, currency: null, via: "swap" };
    }
    if (cash) return { ticker: null, key: null, name, weight, kind: "cash", sector: null, country: null, currency: null, via: null };
    const foreign = raw.match(/^(\S+) ([A-Z0-9]{2})$/);
    if (foreign) {
      const s = SUFFIX[foreign[2]!];
      return { ticker: `${foreign[1]}.${foreign[2]}`, key: null, name, weight, kind: "stock", sector: null, country: s?.country ?? null, currency: s?.currency ?? null, via: null };
    }
    return { ticker: raw, key: raw, name, weight, kind: "stock", sector: null, country: "United States", currency: "USD", via: null };
  });
  if (lines.some((l) => !Number.isFinite(l.weight))) throw changedShape(fund);
  const total = sumWeights(lines);
  if (total < 0.9 || total > 1.1) throw changedShape(fund);
  const exposure = lines.filter((l) => l.kind !== "cash");
  // A swap fund holds T-bills and cash as collateral for the swaps, not as extra exposure.
  if (swaps && sumWeights(exposure) >= 0.95) {
    const sum = sumWeights(exposure);
    return {
      fund,
      source: "roundhill",
      asOf: dayBefore(fileDate),
      lines: exposure.map((l) => ({ ...l, weight: l.weight / sum })),
      note: `Treasury bills and cash back ${fund}'s swaps; they aren't counted as extra exposure.`,
    };
  }
  // Roundhill's page dates the holdings a day before the file's Date column.
  return { fund, source: "roundhill", asOf: dayBefore(fileDate), lines, note: null };
}
