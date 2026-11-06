import type { LineKind } from "./types";

// What a total return swap line is really exposed to, matched on its CUSIP/SEDOL or name. Korean listings have no
// Atrium key (no free source prices them), so they stay as names with a country.
export const SWAP_UNDERLYINGS: { match: RegExp; ticker: string | null; key: string | null; name: string; country: string }[] = [
  { match: /595112103|MICRON/i, ticker: "MU", key: "MU", name: "Micron Technology", country: "United States" },
  { match: /000660|6450267|HYNIX/i, ticker: "000660.KS", key: null, name: "SK hynix", country: "South Korea" },
  { match: /005930|6771720|SAMSUNG/i, ticker: "005930.KS", key: null, name: "Samsung Electronics", country: "South Korea" },
  { match: /BTMTQT8|CXMT|CHANGXIN/i, ticker: null, key: null, name: "CXMT (ChangXin Memory, private)", country: "China" },
];

const SWAP = / TRS |SWAP|TOTAL RETURN/i;
const CASH = /TREASURY|T-BILL|UST BILL|CASH|MONEY MARKET|FGXXX|US DOLLAR/i;

export function classifyLine(
  name: string,
  ticker: string | null,
): { kind: LineKind; swap: boolean; name?: string; resolved?: { ticker: string | null; key: string | null; name: string; country: string } } {
  const label = `${ticker ?? ""} ${name}`;
  if (SWAP.test(` ${label} `)) {
    const u = SWAP_UNDERLYINGS.find((s) => s.match.test(label));
    if (!u) return { kind: "other", swap: true, name: `Swap, underlying not recognised: ${name}` };
    const { match: _match, ...resolved } = u;
    return { kind: "stock", swap: true, resolved };
  }
  if (CASH.test(label)) return { kind: "cash", swap: false };
  return { kind: "stock", swap: false };
}
