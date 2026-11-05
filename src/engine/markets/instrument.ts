export type Exchange = "US" | "TSX" | "TSXV" | "NEO" | "OTC";
export type Instrument = { symbol: string; exchange: Exchange };

const SUFFIX: Record<Exchange, string> = { US: "", TSX: ".TO", TSXV: ".V", NEO: ".NE", OTC: ":OTC" };
const SYMBOL = /^[A-Z0-9][A-Z0-9.\-]{0,14}$/;

export const instrumentKey = (i: Instrument): string => `${i.symbol}${SUFFIX[i.exchange]}`;

// Only the market suffixes above are stripped, so a share-class dot (BRK.B, BBD.B.TO) stays in the symbol.
export function parseInstrumentKey(text: string): Instrument | null {
  const t = text.trim().toUpperCase();
  for (const exchange of ["TSX", "TSXV", "NEO", "OTC"] as const) {
    const suffix = SUFFIX[exchange];
    if (t.endsWith(suffix)) {
      const symbol = t.slice(0, -suffix.length);
      return SYMBOL.test(symbol) ? { symbol, exchange } : null;
    }
  }
  return SYMBOL.test(t) ? { symbol: t, exchange: "US" } : null;
}

const BY_MIC: Record<string, Exchange> = {
  XTSE: "TSX",
  XTSX: "TSXV",
  NEOE: "NEO",
  XNYS: "US",
  XNAS: "US",
  ARCX: "US",
  XASE: "US",
  BATS: "US",
  IEXG: "US",
  OTCM: "OTC",
  OOTC: "OTC",
  PINX: "OTC",
  EXPM: "OTC",
};

const BY_NAME: Record<string, Exchange> = {
  TSX: "TSX",
  "TSX-V": "TSXV",
  TSXV: "TSXV",
  NEO: "NEO",
  "CBOE CANADA": "NEO",
  NYSE: "US",
  NASDAQ: "US",
  "NYSE ARCA": "US",
  "NYSE AMERICAN": "US",
  "CBOE BZX": "US",
  BATS: "US",
};

// The MIC wins: a NEO-listed CDR carries the US company's ticker, and pricing it from the US feed would be wrong.
export function instrumentFromWealthsimple(exchange: string, mic: string): Exchange | null {
  const m = BY_MIC[mic.trim().toUpperCase()];
  if (m) return m;
  const name = exchange.trim().toUpperCase();
  if (BY_NAME[name]) return BY_NAME[name];
  if (name.startsWith("OTC")) return "OTC";
  return null;
}
