import { redact } from "./redact";
import { parseInstrumentKey, instrumentKey, type Exchange, type Instrument } from "./instrument";
import { ProviderError, type MarketProvider, type SearchHit } from "./providers/types";

export const KEEP_TYPES = new Set(["Common Stock", "ETP", "ETF", "ADR", "REIT"]);
const MAX_QUERY = 40;
const MAX_HITS = 12;
const CACHE_MS = 600_000;
const CACHE_MAX = 100;
const ORDER: Record<Exchange, number> = { US: 0, TSX: 1, TSXV: 2, NEO: 3, OTC: 4 };

// Finnhub's search covers every exchange it knows. Only the Canadian suffixes and plain US tickers map to a
// listing Atrium can price; a US share class keeps its dot (BRK.B), anything else (AAPL.SW, APC.DE, 2A4.F) is dropped.
export function mapFinnhubSymbol(symbol: string): Instrument | null {
  const s = symbol.trim().toUpperCase();
  const canadian: [string, Exchange][] = [[".TO", "TSX"], [".V", "TSXV"], [".NE", "NEO"]];
  for (const [suffix, exchange] of canadian) {
    if (s.endsWith(suffix)) {
      const i = parseInstrumentKey(s);
      return i && i.exchange === exchange ? i : null;
    }
  }
  // One-letter suffixes are also foreign venues (.F Frankfurt, .L London, .T Tokyo), so only A–E count as classes.
  if (!/^[A-Z][A-Z0-9\-]*(\.[A-E])?$/.test(s)) return null;
  const i = parseInstrumentKey(s);
  return i?.exchange === "US" ? i : null;
}

export function finnhubHits(rows: { description: string; symbol: string; type: string }[]): SearchHit[] {
  const out: SearchHit[] = [];
  for (const r of rows) {
    const i = mapFinnhubSymbol(r.symbol);
    if (i) out.push({ key: instrumentKey(i), symbol: i.symbol, exchange: i.exchange, name: r.description, type: r.type, note: null });
  }
  return out;
}

const PREFIXED = /^(TSX|TSXV|NEO):([A-Z0-9][A-Z0-9.\-]{0,14})$/;
const TYPED_NOTE: Partial<Record<Exchange, string>> = {
  TSX: "Not in Finnhub's search. Atrium will price it from Alpha Vantage after the close.",
  TSXV: "Not in Finnhub's search. Atrium will price it from Alpha Vantage after the close.",
  NEO: "Not in Finnhub's search. No free source prices NEO listings.",
};

// Finnhub's free search misses some Canadian listings, so a typed Canadian key is always offered.
export function typedKey(q: string): SearchHit | null {
  const t = q.trim().toUpperCase();
  const m = t.match(PREFIXED);
  const i = m ? parseInstrumentKey(`${m[2]}${m[1] === "TSX" ? ".TO" : m[1] === "TSXV" ? ".V" : ".NE"}`) : /\.(TO|V|NE)$/.test(t) ? parseInstrumentKey(t) : null;
  if (!i || !TYPED_NOTE[i.exchange]) return null;
  const key = instrumentKey(i);
  return { key, symbol: i.symbol, exchange: i.exchange, name: key, type: "typed", note: TYPED_NOTE[i.exchange]! };
}

const KEEP_UPPER = new Set(["ETF", "ETN", "ETP", "SPDR", "S&P", "ADR", "REIT", "US", "USA", "AI", "II", "III", "IV", "NV", "PLC", "AG", "SA", "MSCI", "ESG", "QQQ", "TSX", "NYSE"]);
const titleCase = (s: string) =>
  s
    .toLowerCase()
    .split(/(\s+)/)
    .map((w) => (KEEP_UPPER.has(w.toUpperCase()) ? w.toUpperCase() : w.replace(/^[a-z]/, (c) => c.toUpperCase())))
    .join("");

export type SearchResult = { hits: SearchHit[]; note: string | null };

const cache = new Map<string, { at: number; hits: SearchHit[] }>();
export const clearSearchCache = (): void => cache.clear();

function failureNote(e: unknown): string {
  if (e instanceof ProviderError && e.kind === "rate_limited") return "Finnhub is busy. Try again in a minute.";
  if (e instanceof ProviderError && e.kind === "auth") return redact(e.message, []);
  return "Finnhub didn't answer. Try again in a minute.";
}

export async function searchSymbols(provider: MarketProvider | null, q: string, now: () => number = Date.now): Promise<SearchResult> {
  const query = q.trim();
  if (!query) throw new Error("Type a name or a symbol.");
  if (query.length > MAX_QUERY) throw new Error("Keep the search under 40 characters.");
  const typed = typedKey(query);
  if (!provider?.search) return { hits: typed ? [typed] : [], note: "Add your Finnhub key in Settings → Market data to search by name." };

  const id = query.toLowerCase();
  const cached = cache.get(id);
  let hits: SearchHit[];
  if (cached && now() - cached.at < CACHE_MS) hits = cached.hits;
  else {
    try {
      hits = tidy(await provider.search(query));
    } catch (e) {
      return { hits: typed ? [typed] : [], note: failureNote(e) };
    }
    cache.delete(id);
    cache.set(id, { at: now(), hits });
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  }
  if (typed && !hits.some((h) => h.key === typed.key)) hits = [typed, ...hits];
  return { hits, note: null };
}

function tidy(raw: SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  return raw
    .filter((h) => KEEP_TYPES.has(h.type) && !seen.has(h.key) && !!seen.add(h.key))
    // Finnhub shouts (ARITZIA INC); names already in mixed case are left alone.
    .map((h, n) => ({ ...h, name: h.name === h.name.toUpperCase() ? titleCase(h.name) : h.name, n }))
    .sort((a, b) => ORDER[a.exchange] - ORDER[b.exchange] || a.n - b.n)
    .slice(0, MAX_HITS)
    .map(({ n: _n, ...h }) => h);
}
