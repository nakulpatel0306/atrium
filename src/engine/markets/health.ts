// Pure: portfolio health from positions, the USD/CAD rate, fund look-through and instrument metadata.
import type { LookThrough } from "./funds/lookthrough";
import type { Meta } from "./meta";
import { etDay, fxLabel, mixLabel, toCad, type Sourced } from "./sourced";

// My calls; easy to change.
export const CONCENTRATION = { company: 0.1, holding: 0.25, sector: 0.35, country: 0.85, overlap: 0.5 };
const OVERLAP_LISTED = 0.2;
const TOP_COMPANIES = 25;

export type Position = {
  key: string;
  account: string;
  quantity: number;
  price: Sourced | null;
  prevClose: number | null;
  listingCcy: "CAD" | "USD";
  bookValue: number | null;
  bookCcy: "CAD" | "USD";
  bookValueCad: number | null;
  kind: "stock" | "etf" | "unknown";
};
export type Slice = { label: string; cad: number; pct: number };
export type CompanySlice = Slice & { key: string | null; direct: number; via: { holding: string; pct: number }[] };
export type Warning = { kind: "company" | "holding" | "sector" | "country" | "overlap" | "unpriced" | "no_breakdown" | "no_fx"; text: string };
export type HoldingPnl = {
  key: string;
  account: string;
  value: Sourced | null;
  valueCad: number | null;
  gain: number | null;
  gainPct: number | null;
  gainCad: number | null;
  gainCadPct: number | null;
  bookNote: string | null;
};
export type Health = {
  totalCad: Sourced | null;
  dayCad: Sourced | null;
  dayPct: number | null;
  byHolding: Slice[];
  byAssetClass: Slice[];
  bySector: Slice[];
  byCountry: Slice[];
  byCurrency: Slice[];
  byListingCurrency: Slice[];
  byCompany: CompanySlice[];
  overlap: { a: string; b: string; pct: number }[];
  warnings: Warning[];
  pnl: HoldingPnl[];
  lookThroughCoverage: number;
  // The ET date the day change is for: today in session, else the latest session the prices come from.
  dayOf: string | null;
};

const pct1 = (n: number) => (n > 0 && n < 0.05 ? "<0.1%" : `${(Math.round(n * 10) / 10).toFixed(1)}%`);
const pct0 = (n: number) => `${Math.round(n)}%`;
const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const UNKNOWN = "Unknown";
const CONVERTED_BOOK = "Book value converted at today's rate; import a Wealthsimple holdings file for the real CAD cost.";

function slices(m: Map<string, number>, total: number): Slice[] {
  return [...m.entries()].map(([label, cad]) => ({ label, cad, pct: (cad / total) * 100 })).sort((a, b) => b.cad - a.cad);
}
const bump = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);

export function portfolioHealth(i: {
  positions: Position[];
  fx: Sourced | null;
  lookThrough: Map<string, LookThrough>;
  meta: Map<string, Meta>;
  // Why a fund has no breakdown, for its warning.
  unavailable?: Map<string, string>;
  now?: number;
}): Health {
  const warnings: Warning[] = [];
  const unpriced = i.positions.filter((p) => !p.price);
  if (unpriced.length) {
    const keys = [...new Set(unpriced.map((p) => p.key))];
    warnings.push({
      kind: "unpriced",
      text: keys.length === 1 ? `1 holding has no price, so totals leave it out: ${keys[0]}.` : `${keys.length} holdings have no price, so totals leave them out: ${keys.join(", ")}.`,
    });
  }
  const priced = i.positions.filter((p) => p.price);
  const counted = priced.filter((p) => toCad(1, p.listingCcy, i.fx) !== null);
  if (!i.fx && priced.some((p) => p.listingCcy === "USD")) warnings.push({ kind: "no_fx", text: "No USD/CAD rate yet, so US holdings aren't in the CAD totals." });

  const valueCad = (p: Position) => toCad(p.quantity * p.price!.value, p.listingCcy, i.fx)!;
  const total = counted.reduce((a, p) => a + valueCad(p), 0);
  const pnl = i.positions.map((p) => pnlOf(p, i.fx));
  if (!counted.length || total <= 0) {
    return { totalCad: null, dayCad: null, dayPct: null, byHolding: [], byAssetClass: [], bySector: [], byCountry: [], byCurrency: [], byListingCurrency: [], byCompany: [], overlap: [], warnings, pnl, lookThroughCoverage: 0, dayOf: null };
  }

  const mix = mixLabel(counted.map((p) => p.price!));
  const usesFx = counted.some((p) => p.listingCcy === "USD");
  const source = usesFx && i.fx ? `${mix.text} · ${fxLabel(i.fx)}` : mix.text;
  const asOf = Math.max(...counted.map((p) => p.price!.asOf));
  const totalCad: Sourced = { value: total, source, asOf, tone: mix.tone };

  // A day change only adds up moves from the same session: a price from an earlier day (a Canadian close, a
  // symbol that didn't trade) carries that day's move, so it's left out of today's and named.
  const latest = counted.map((p) => etDay(p.price!.asOf)).sort().at(-1)!;
  const dayOf = i.now !== undefined && counted.some((p) => etDay(p.price!.asOf) === etDay(i.now!)) ? etDay(i.now) : latest;
  const earlier = counted.filter((p) => p.prevClose && etDay(p.price!.asOf) !== dayOf);
  if (earlier.length) {
    const names = earlier.map((p) => `${p.key} (${p.price!.source.replace(/^.* · /, "")})`);
    const label = dayOf === (i.now !== undefined ? etDay(i.now) : dayOf) ? "today's" : "the day's";
    warnings.push({
      kind: "unpriced",
      text:
        earlier.length === 1
          ? `1 holding isn't in ${label} change because its price is from an earlier day: ${names[0]}.`
          : `${earlier.length} holdings aren't in ${label} change because their prices are from an earlier day: ${names.join(", ")}.`,
    });
  }
  const moved = counted.filter((p) => p.prevClose && etDay(p.price!.asOf) === dayOf);
  const dayValue = moved.reduce((a, p) => a + toCad(p.quantity * (p.price!.value - p.prevClose!), p.listingCcy, i.fx)!, 0);
  const prevValue = moved.reduce((a, p) => a + toCad(p.quantity * p.prevClose!, p.listingCcy, i.fx)!, 0);
  const dayCad: Sourced | null = moved.length ? { value: dayValue, source, asOf, tone: mix.tone } : null;
  const dayPct = moved.length && prevValue > 0 ? (dayValue / prevValue) * 100 : null;

  const byHolding = new Map<string, number>();
  const byAsset = new Map<string, number>();
  const bySector = new Map<string, number>();
  const byCountry = new Map<string, number>();
  const byCurrency = new Map<string, number>();
  const byListing = new Map<string, number>();
  type Co = { label: string; key: string | null; cad: number; direct: number; via: Map<string, number> };
  const companies = new Map<string, Co>();
  const company = (id: string, label: string, key: string | null) => {
    let c = companies.get(id);
    if (!c) companies.set(id, (c = { label, key, cad: 0, direct: 0, via: new Map() }));
    return c;
  };
  let resolved = 0;
  let fundValue = 0;
  const fundWeights = new Map<string, Map<string, number>>();

  for (const p of counted) {
    const v = valueCad(p);
    bump(byHolding, p.key, v);
    bump(byAsset, p.kind === "etf" ? "ETFs" : p.kind === "stock" ? "Stocks" : "Other", v);
    bump(byListing, p.listingCcy, v);
    const m = i.meta.get(p.key);
    if (p.kind !== "etf") {
      bump(bySector, m?.sector ?? UNKNOWN, v);
      bump(byCountry, m?.country ?? UNKNOWN, v);
      bump(byCurrency, m?.currency ?? p.listingCcy, v);
      const c = company(p.key, p.key, p.key);
      c.cad += v;
      c.direct += v;
      continue;
    }
    fundValue += v;
    const lt = i.lookThrough.get(p.key);
    if (!lt) {
      bump(bySector, UNKNOWN, v);
      bump(byCountry, UNKNOWN, v);
      bump(byCurrency, p.listingCcy, v);
      company(`${p.key} (no breakdown)`, `${p.key} (no breakdown)`, null).cad += v;
      const reason = i.unavailable?.get(p.key) ?? "no holdings file yet";
      if (!warnings.some((w) => w.kind === "no_breakdown" && w.text.startsWith(`${p.key}:`))) warnings.push({ kind: "no_breakdown", text: `${p.key}: breakdown unavailable (${reason}).` });
      continue;
    }
    const weights = fundWeights.get(p.key) ?? new Map<string, number>();
    fundWeights.set(p.key, weights);
    for (const e of lt.exposures) {
      const ev = v * e.weight;
      const cash = e.kind === "cash";
      bump(bySector, cash ? "Cash" : (e.sector ?? i.meta.get(e.key ?? "")?.sector ?? UNKNOWN), ev);
      bump(byCountry, e.country ?? UNKNOWN, ev);
      bump(byCurrency, e.currency ?? p.listingCcy, ev);
      const id = cash ? "Cash in funds" : e.company;
      const c = company(id, cash ? "Cash in funds" : (e.key ?? e.ticker ?? e.name), cash ? null : (e.key ?? e.ticker));
      c.cad += ev;
      c.via.set(p.key, (c.via.get(p.key) ?? 0) + ev);
      if (!cash) bump(weights, id, e.weight);
      if (e.kind === "stock") resolved += ev;
    }
  }

  const pctOf = (cad: number) => (cad / total) * 100;
  const sortedCos = [...companies.values()].sort((a, b) => b.cad - a.cad);
  const toSlice = (c: Co): CompanySlice => ({
    label: c.label,
    key: c.key,
    cad: c.cad,
    pct: pctOf(c.cad),
    direct: pctOf(c.direct),
    via: [...c.via.entries()].map(([holding, cad]) => ({ holding, pct: pctOf(cad) })).sort((a, b) => b.pct - a.pct),
  });
  const byCompany = sortedCos.slice(0, TOP_COMPANIES).map(toSlice);
  const rest = sortedCos.slice(TOP_COMPANIES);
  if (rest.length) {
    const cad = rest.reduce((a, c) => a + c.cad, 0);
    byCompany.push({ label: "Other", key: null, cad, pct: pctOf(cad), direct: 0, via: [] });
  }

  for (const c of sortedCos) {
    if (c.key === null || c.cad / total <= CONCENTRATION.company) continue;
    const via = [...c.via.entries()].sort((a, b) => b[1] - a[1]).map(([h, cad]) => `${h} ${pct1(pctOf(cad))}`);
    const text = c.direct
      ? via.length
        ? `${c.label} is ${pct1(pctOf(c.cad))} of your portfolio (direct ${pct1(pctOf(c.direct))}; through ${via.join(", ")}).`
        : `${c.label} is ${pct1(pctOf(c.cad))} of your portfolio.`
      : `${c.label} is ${pct1(pctOf(c.cad))} of your portfolio through ${list([...c.via.keys()])}.`;
    warnings.push({ kind: "company", text });
  }
  // A broad fund isn't concentration; a single stock is, unless its company warning already says so.
  for (const [key, cad] of byHolding) {
    const p = counted.find((x) => x.key === key)!;
    const said = warnings.some((w) => w.kind === "company" && w.text.startsWith(`${key} is `));
    if (p.kind !== "etf" && !said && cad / total > CONCENTRATION.holding) warnings.push({ kind: "holding", text: `${key} on its own is ${pct1(pctOf(cad))} of your portfolio.` });
  }
  for (const s of slices(bySector, total)) {
    if (s.label !== UNKNOWN && s.label !== "Cash" && s.pct / 100 > CONCENTRATION.sector) warnings.push({ kind: "sector", text: `${s.label} is ${pct0(s.pct)} of your portfolio.` });
  }
  for (const s of slices(byCountry, total)) {
    if (s.label !== UNKNOWN && s.pct / 100 > CONCENTRATION.country) warnings.push({ kind: "country", text: `${s.label} is ${pct0(s.pct)} of your portfolio.` });
  }

  const funds = [...fundWeights.keys()];
  const overlap: { a: string; b: string; pct: number }[] = [];
  for (let x = 0; x < funds.length; x++) {
    for (let y = x + 1; y < funds.length; y++) {
      const a = fundWeights.get(funds[x]!)!;
      const b = fundWeights.get(funds[y]!)!;
      let shared = 0;
      for (const [k, w] of a) shared += Math.min(w, b.get(k) ?? 0);
      if (shared >= OVERLAP_LISTED) overlap.push({ a: funds[x]!, b: funds[y]!, pct: shared * 100 });
      if (shared >= CONCENTRATION.overlap) warnings.push({ kind: "overlap", text: `${funds[x]} and ${funds[y]} overlap ${pct0(shared * 100)}.` });
    }
  }

  return {
    totalCad,
    dayCad,
    dayPct,
    byHolding: slices(byHolding, total),
    byAssetClass: slices(byAsset, total),
    bySector: slices(bySector, total),
    byCountry: slices(byCountry, total),
    byCurrency: slices(byCurrency, total),
    byListingCurrency: slices(byListing, total),
    byCompany,
    overlap: overlap.sort((a, b) => b.pct - a.pct),
    warnings,
    pnl,
    lookThroughCoverage: fundValue > 0 ? resolved / fundValue : 1,
    dayOf,
  };
}

function pnlOf(p: Position, fx: Sourced | null): HoldingPnl {
  const value: Sourced | null = p.price ? { ...p.price, value: p.quantity * p.price.value } : null;
  const valueCad = value ? toCad(value.value, p.listingCcy, fx) : null;
  const empty = { key: p.key, account: p.account, value, valueCad, gain: null, gainPct: null, gainCad: null, gainCadPct: null };
  if (p.bookValue === null && p.bookValueCad === null) return { ...empty, bookNote: "No book value." };
  const gain = value && p.bookValue !== null && p.bookCcy === p.listingCcy ? value.value - p.bookValue : null;
  const gainPct = gain !== null && p.bookValue ? (gain / p.bookValue) * 100 : null;
  let bookCad = p.bookValueCad;
  let bookNote: string | null = null;
  if (bookCad === null && p.bookValue !== null) {
    bookCad = toCad(p.bookValue, p.bookCcy, fx);
    if (p.bookCcy === "USD") bookNote = CONVERTED_BOOK;
  }
  const gainCad = valueCad !== null && bookCad !== null ? valueCad - bookCad : null;
  const gainCadPct = gainCad !== null && bookCad ? (gainCad / bookCad) * 100 : null;
  return { ...empty, gain, gainPct, gainCad, gainCadPct, bookNote };
}
