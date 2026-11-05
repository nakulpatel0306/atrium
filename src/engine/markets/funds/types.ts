// An issuer's holdings file, reduced to what look-through needs.
export type LineKind = "stock" | "fund" | "cash" | "other";
export type FundLine = {
  ticker: string | null;
  key: string | null;
  name: string;
  // Fraction of the fund, 0..1.
  weight: number;
  kind: LineKind;
  sector: string | null;
  country: string | null;
  currency: string | null;
  // "swap" when the exposure is held through a total return swap.
  via: string | null;
};
export type FundSourceId = "ishares-ca" | "ishares-us" | "ssga" | "roundhill" | "invesco" | "ndx-estimate";
export type FundFile = { fund: string; source: FundSourceId; asOf: string; lines: FundLine[]; note: string | null };

// Its message is a plain sentence for Nakul.
export class FundFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FundFileError";
  }
}

export const changedShape = (fund: string) => new FundFileError(`The ${fund} holdings file has changed shape; Atrium couldn't find its holdings table.`);

const MONTHS: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };

// "Nov 4, 2026", "Nov 03, 2026", "04-Nov-2026" or "11/04/2026" → "2026-11-04"; null when it's none of those.
export function isoDate(raw: string): string | null {
  const t = raw.trim();
  let m = t.match(/^([A-Za-z]{3})[a-z]*\.? (\d{1,2}), (\d{4})$/);
  if (m && MONTHS[m[1]!.toLowerCase()]) return `${m[3]}-${MONTHS[m[1]!.toLowerCase()]}-${m[2]!.padStart(2, "0")}`;
  m = t.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (m && MONTHS[m[2]!.toLowerCase()]) return `${m[3]}-${MONTHS[m[2]!.toLowerCase()]}-${m[1]!.padStart(2, "0")}`;
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  return null;
}

// "1,234.5" → 1234.5; "-" and blanks are NaN.
export const num = (raw: string | undefined): number => {
  const t = (raw ?? "").replace(/[,%\s]/g, "");
  return t === "" || t === "-" ? NaN : Number(t);
};

export const sumWeights = (lines: { weight: number }[]) => lines.reduce((a, l) => a + l.weight, 0);
