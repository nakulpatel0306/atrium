// Issuer sector spellings → the 11 GICS sectors. Cash and derivative buckets aren't a sector.
const GICS = [
  "Information Technology",
  "Health Care",
  "Financials",
  "Consumer Discretionary",
  "Communication Services",
  "Industrials",
  "Consumer Staples",
  "Energy",
  "Utilities",
  "Real Estate",
  "Materials",
];
const ALIASES: Record<string, string> = {
  "it": "Information Technology",
  "technology": "Information Technology",
  "info tech": "Information Technology",
  "healthcare": "Health Care",
  "financial": "Financials",
  "communication": "Communication Services",
  "communications": "Communication Services",
  "telecommunication services": "Communication Services",
  "consumer cyclical": "Consumer Discretionary",
  "consumer defensive": "Consumer Staples",
  "basic materials": "Materials",
  "real-estate": "Real Estate",
};

export function normalizeSector(raw: string | null): string | null {
  const t = (raw ?? "").trim();
  if (!t || t === "-" || /cash|derivative/i.test(t)) return null;
  const exact = GICS.find((g) => g.toLowerCase() === t.toLowerCase());
  return exact ?? ALIASES[t.toLowerCase()] ?? null;
}
