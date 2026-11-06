import { FundFileError, type FundFile } from "./types";

// When Invesco's file can't be read, QQQ is estimated from the Nasdaq-100's members (Wikipedia, CC BY-SA) weighted
// by their S&P 500 weights, and labelled as an estimate everywhere it shows.
export const NDX_WIKI_URL = "https://en.wikipedia.org/w/api.php?action=parse&page=List_of_NASDAQ-100_companies&prop=wikitext&format=json&redirects=1";
const UNREADABLE = "Wikipedia's Nasdaq-100 list has changed shape; Atrium couldn't find its components table.";

export function parseNdxMembers(wikitextJson: string): string[] {
  let text: string;
  try {
    text = (JSON.parse(wikitextJson) as { parse: { wikitext: { "*": string } } }).parse.wikitext["*"];
  } catch {
    throw new FundFileError(UNREADABLE);
  }
  if (typeof text !== "string") throw new FundFileError(UNREADABLE);
  const start = text.search(/\n!\s*Ticker\b/);
  if (start < 0) throw new FundFileError(UNREADABLE);
  const end = text.indexOf("\n|}", start);
  const table = text.slice(start, end < 0 ? undefined : end);
  const out: string[] = [];
  for (const row of table.split(/\n\|-/).slice(1)) {
    const first = row.trim().replace(/^\|\s*/, "").split("||")[0]?.trim() ?? "";
    const ticker = first.replace(/\[\[[^|\]]*\|?([^\]]*)\]\]/g, "$1").trim();
    if (/^[A-Z][A-Z.]{0,5}$/.test(ticker)) out.push(ticker);
  }
  if (out.length < 50) throw new FundFileError(UNREADABLE);
  return [...new Set(out)];
}

export function ndxEstimate(members: string[], spy: FundFile): FundFile {
  const byTicker = new Map(spy.lines.filter((l) => l.ticker).map((l) => [l.ticker!.toUpperCase(), l]));
  const matched = members.map((m) => byTicker.get(m.toUpperCase())).filter((l) => l !== undefined);
  const unmatched = members.filter((m) => !byTicker.has(m.toUpperCase()));
  const total = matched.reduce((a, l) => a + l.weight, 0);
  return {
    fund: "QQQ",
    source: "ndx-estimate",
    asOf: spy.asOf,
    lines: matched.map((l) => ({ ...l, weight: total > 0 ? l.weight / total : 0 })),
    note: `Estimate: Nasdaq-100 members (from Wikipedia, CC BY-SA) weighted by their S&P 500 weights.${unmatched.length ? ` Not counted: ${unmatched.join(", ")}.` : ""}`,
  };
}
