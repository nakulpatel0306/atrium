import { etInstant } from "../calendar";
import { closeDayText, type Sourced } from "../sourced";
import { FUND_SOURCES } from "./sources";
import type { FundFile, LineKind } from "./types";

export type Exposure = {
  // Merge key: the same company reached through several funds is summed under it.
  company: string;
  ticker: string | null;
  key: string | null;
  name: string;
  weight: number;
  kind: LineKind;
  sector: string | null;
  country: string | null;
  currency: string | null;
  // The funds passed through on the way, outermost first.
  via: string[];
};
export type LookThrough = {
  fund: string;
  exposures: Exposure[];
  // Share of the fund resolved to companies.
  coverage: number;
  sources: Sourced<string>[];
  unavailable: { fund: string; reason: string }[];
  note: string | null;
};

const MAX_DEPTH = 3;
const LABEL: Record<FundFile["source"], string> = {
  "ishares-ca": "iShares holdings file",
  "ishares-us": "iShares holdings file",
  ssga: "SSGA holdings file",
  roundhill: "Roundhill holdings file",
  invesco: "Invesco holdings file",
  "ndx-estimate": "Estimate from Nasdaq-100 members · SPY weights",
};

export function fileSource(f: FundFile): Sourced<string> {
  const asOf = etInstant(f.asOf, "16:00");
  if (f.source === "ndx-estimate") return { value: f.fund, source: LABEL[f.source], asOf, tone: "estimate" };
  return { value: f.fund, source: `${LABEL[f.source]} · ${closeDayText(asOf)}`, asOf, tone: "official" };
}

const STOP_WORDS = /\b(INC|CORP|CORPORATION|CO|LTD|PLC|SA|AG|NV|THE|CLASS [A-Z])\b/g;

// Listing keys when there are any (so Telus T.TO and AT&T T stay apart), share-class separators folded to "." and
// Alphabet's two classes treated as one company; a line without a ticker merges on its normalized name.
export function companyKey(line: { ticker: string | null; key?: string | null; name: string; country: string | null }): string {
  const raw = line.key ?? line.ticker;
  if (raw) {
    const k = raw.toUpperCase().replace(/[/\s-]+/g, ".");
    return k === "GOOG" ? "GOOGL" : k;
  }
  return line.name.toUpperCase().replace(/[^A-Z0-9 ]+/g, " ").replace(STOP_WORDS, " ").replace(/\s+/g, " ").trim();
}

const aliasOf = (key: string) => {
  const s = FUND_SOURCES[key];
  return s?.kind === "alias" ? s : null;
};

export function lookThrough(load: (fund: string) => FundFile | null, fund: string): LookThrough {
  const alias = aliasOf(fund);
  const top = alias ? alias.of : fund;
  const merged = new Map<string, Exposure>();
  const sources: Sourced<string>[] = [];
  const unavailable: { fund: string; reason: string }[] = [];
  const used = new Set<string>();

  const add = (e: Exposure) => {
    const cur = merged.get(e.company);
    if (!cur) merged.set(e.company, { ...e, via: [...e.via] });
    else {
      cur.weight += e.weight;
      for (const v of e.via) if (!cur.via.includes(v)) cur.via.push(v);
    }
  };
  const opaque = (ticker: string, weight: number, path: string[]) => {
    add({ company: `${ticker} (fund)`, ticker, key: ticker, name: `${ticker} (fund, no breakdown)`, weight, kind: "fund", sector: null, country: null, currency: null, via: path });
  };
  const missing = (ticker: string) => {
    if (!unavailable.some((u) => u.fund === ticker)) unavailable.push({ fund: ticker, reason: `No holdings file for ${ticker}` });
  };

  const walk = (key: string, weight: number, path: string[]) => {
    const file = load(key);
    if (!file) {
      opaque(key, weight, path.slice(0, -1));
      missing(key);
      return;
    }
    if (!used.has(key)) {
      used.add(key);
      sources.push(fileSource(file));
    }
    for (const l of file.lines) {
      const w = weight * l.weight;
      if (l.kind === "fund") {
        const label = l.ticker ?? l.name;
        const target = l.key ? (aliasOf(l.key)?.of ?? l.key) : null;
        // path holds the top fund too, so its length is the next level's depth.
        if (target && path.length <= MAX_DEPTH && !path.includes(target) && load(target)) walk(target, w, [...path, target]);
        else {
          if (target && !path.includes(target) && !load(target)) missing(label);
          opaque(label, w, path);
        }
        continue;
      }
      add({
        company: companyKey(l),
        ticker: l.ticker,
        key: l.key,
        name: l.name,
        weight: w,
        kind: l.kind,
        sector: l.sector,
        country: l.country,
        currency: l.currency,
        via: path,
      });
    }
  };
  walk(top, 1, [top]);

  const exposures = [...merged.values()].sort((a, b) => b.weight - a.weight);
  const coverage = exposures.filter((e) => e.kind === "stock").reduce((a, e) => a + e.weight, 0);
  const topFile = load(top);
  return { fund, exposures, coverage, sources, unavailable, note: alias?.note ?? topFile?.note ?? null };
}
