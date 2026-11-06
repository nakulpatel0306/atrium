import { expect, test } from "bun:test";
import type { LookThrough } from "../../../src/engine/markets/funds/lookthrough";
import { lookThrough } from "../../../src/engine/markets/funds/lookthrough";
import type { FundFile, FundLine } from "../../../src/engine/markets/funds/types";
import { CONCENTRATION, portfolioHealth, type Position } from "../../../src/engine/markets/health";
import type { Meta } from "../../../src/engine/markets/meta";
import type { Sourced } from "../../../src/engine/markets/sourced";

const CLOSE = Date.parse("2026-11-04T21:00:00Z");
const fx: Sourced = { value: 1.4, source: "Bank of Canada · Nov 4", asOf: Date.parse("2026-11-04T21:30:00Z"), tone: "official" };
const live = (value: number): Sourced => ({ value, source: "Finnhub · real-time", asOf: CLOSE + 60_000, tone: "live" });
const eod = (value: number): Sourced => ({ value, source: "Alpha Vantage · close of Nov 4", asOf: CLOSE, tone: "delayed" });

const pos = (p: Partial<Position> & Pick<Position, "key">): Position => ({
  account: "TFSA",
  quantity: 1,
  price: null,
  prevClose: null,
  listingCcy: "USD",
  bookValue: null,
  bookCcy: "USD",
  bookValueCad: null,
  kind: "stock",
  ...p,
});
const POSITIONS: Position[] = [
  pos({ key: "AAPL", quantity: 10, price: live(200), prevClose: 198, bookValue: 1500, bookValueCad: 2000 }),
  pos({ key: "SPY", quantity: 4, price: live(500), prevClose: 495, kind: "etf" }),
  pos({ key: "VFV.TO", quantity: 20, price: eod(70), prevClose: 69, listingCcy: "CAD", bookCcy: "CAD", kind: "etf" }),
];

const stock = (ticker: string, weight: number, sector = "Information Technology"): FundLine => ({
  ticker,
  key: ticker,
  name: ticker,
  weight,
  kind: "stock",
  sector,
  country: "United States",
  currency: "USD",
  via: null,
});
const SPY_FILE: FundFile = {
  fund: "SPY",
  source: "ssga",
  asOf: "2026-11-04",
  note: null,
  lines: [stock("AAPL", 0.07), stock("MSFT", 0.065), ...Array.from({ length: 50 }, (_, i) => stock(`S${i}`, 0.865 / 50, i % 2 ? "Financials" : "Health Care"))],
};
const lt = (fund: string) => lookThrough((f) => (f === "SPY" ? SPY_FILE : null), fund);
const LT = new Map<string, LookThrough>([
  ["SPY", lt("SPY")],
  ["VFV.TO", lt("VFV.TO")],
]);
const meta = new Map<string, Meta>([
  ["AAPL", { key: "AAPL", name: "Apple", kind: "stock", sector: "Information Technology", sectorSource: "x", country: "United States", currency: "USD", pe: null, high52: null, low52: null, divYield: null, metricsAt: null, listing: null, marketCap: null }],
]);
const health = (over: Partial<Parameters<typeof portfolioHealth>[0]> = {}) => portfolioHealth({ positions: POSITIONS, fx, lookThrough: LT, meta, ...over });

test("the CAD total says which prices it mixes and the rate it used", () => {
  const h = health();
  expect(h.totalCad!.value).toBeCloseTo(7000, 9);
  expect(h.totalCad!.source).toContain("2 real-time · 1 close of Nov 4");
  expect(h.totalCad!.source).toContain("at Bank of Canada USD/CAD 1.4000 (Nov 4)");
  expect(h.totalCad!.tone).toBe("delayed");
  // (10×2 + 4×5) × 1.40 + 20×1 = 76 on a previous value of 6924.
  expect(h.dayCad!.value).toBeCloseTo(76, 9);
  expect(h.dayPct!).toBeCloseTo((76 / 6924) * 100, 9);
  expect(h.dayCad!.source).toBe(h.totalCad!.source);
});

test("a company owned directly and through funds is summed, with the breakdown", () => {
  const h = health();
  const aapl = h.byCompany.find((c) => c.key === "AAPL")!;
  expect(aapl.pct).toBeCloseTo(44.2, 9);
  expect(aapl.cad).toBeCloseTo(3094, 9);
  expect(aapl.direct).toBeCloseTo(40, 9);
  expect(aapl.via.map((v) => [v.holding, Math.round(v.pct * 10) / 10])).toEqual([["SPY", 2.8], ["VFV.TO", 1.4]]);
  expect(h.warnings.map((w) => w.text)).toContain("AAPL is 44.2% of your portfolio (direct 40.0%; through SPY 2.8%, VFV.TO 1.4%).");
  expect(h.warnings.find((w) => w.kind === "company")!.text).toContain("AAPL");
  expect(h.byCompany.length).toBeLessThanOrEqual(26);
  expect(h.byCompany.at(-1)!.label).toBe("Other");
});

test("currency by exposure and by listing, and overlap between funds", () => {
  const h = health();
  expect(h.byCurrency.map((s) => [s.label, Math.round(s.pct)])).toEqual([["USD", 100]]);
  expect(h.byListingCurrency.map((s) => [s.label, Math.round(s.pct)])).toEqual([["USD", 80], ["CAD", 20]]);
  expect(h.overlap.map((o) => [o.a, o.b, Math.round(o.pct)])).toEqual([["SPY", "VFV.TO", 100]]);
  // Same rounding as the overlap table.
  expect(h.warnings.map((w) => w.text)).toContain("SPY and VFV.TO overlap 100.0%.");
  expect(h.warnings.map((w) => w.text)).toContain("United States is 100% of your portfolio.");
  expect(h.byHolding.map((s) => [s.label, Math.round(s.pct)])).toEqual([["AAPL", 40], ["SPY", 40], ["VFV.TO", 20]]);
  expect(h.byAssetClass.map((s) => [s.label, Math.round(s.pct)])).toEqual([["ETFs", 60], ["Stocks", 40]]);
  expect(h.lookThroughCoverage).toBeCloseTo(1, 9);
  expect(CONCENTRATION).toEqual({ company: 0.1, holding: 0.25, sector: 0.35, country: 0.85, overlap: 0.5 });
});

test("per-holding gains in the listing currency and in CAD", () => {
  const p = health().pnl.find((r) => r.key === "AAPL")!;
  expect(p.gain).toBeCloseTo(500, 9);
  expect(p.gainPct!).toBeCloseTo(33.333, 2);
  expect(p.valueCad).toBeCloseTo(2800, 9);
  expect(p.gainCad).toBeCloseTo(800, 9);
  expect(p.gainCadPct).toBeCloseTo(40, 9);
  expect(p.bookNote).toBeNull();
  const spy = health().pnl.find((r) => r.key === "SPY")!;
  expect([spy.gain, spy.gainCad, spy.bookNote]).toEqual([null, null, "No book value."]);
  const converted = health({ positions: [pos({ key: "NOW", quantity: 1, price: live(100), bookValue: 80 })] }).pnl[0]!;
  expect(converted.gainCad).toBeCloseTo(28, 9);
  expect(converted.bookNote).toBe("Book value converted at today's rate; import a Wealthsimple holdings file for the real CAD cost.");
});

test("no breakdown is one line", () => {
  const h = health({ lookThrough: new Map([["SPY", LT.get("SPY")!]]), unavailable: new Map([["VFV.TO", "No holdings file for SPY"]]) });
  const vfv = h.byCompany.find((c) => c.label === "VFV.TO (no breakdown)")!;
  expect(vfv.pct).toBeCloseTo(20, 9);
  expect(h.bySector.find((s) => s.label === "Unknown")!.pct).toBeCloseTo(20, 9);
  expect(h.warnings.map((w) => w.text)).toContain("VFV.TO: breakdown unavailable (No holdings file for SPY).");
  expect(h.byCompany.find((c) => c.key === "AAPL")!.pct).toBeCloseTo(42.8, 9);
});

test("unpriced holdings and a missing rate are left out, and said so", () => {
  const h = health({ positions: [...POSITIONS, pos({ key: "QBTS", quantity: 3 })] });
  expect(h.totalCad!.value).toBeCloseTo(7000, 9);
  expect(h.warnings.map((w) => w.text)).toContain("1 holding has no price, so totals leave it out: QBTS.");
  const noFx = health({ fx: null });
  expect(noFx.totalCad!.value).toBeCloseTo(1400, 9);
  expect(noFx.totalCad!.source).not.toContain("Bank of Canada");
  expect(noFx.warnings.map((w) => w.text)).toContain("No USD/CAD rate yet, so US holdings aren't in the CAD totals.");
  expect(health({ positions: [] }).totalCad).toBeNull();
});

test("tiny shares read <0.1%, and a stock's company warning isn't repeated as a holding warning", () => {
  const big = pos({ key: "SOFI", quantity: 100, price: live(100), kind: "stock" });
  const tinyFund: FundFile = { fund: "SPY", source: "ssga", asOf: "2026-11-04", note: null, lines: [stock("SOFI", 0.0001), stock("MSFT", 0.9999)] };
  const h = portfolioHealth({ positions: [big, pos({ key: "SPY", quantity: 10, price: live(500), kind: "etf" })], fx, lookThrough: new Map([["SPY", lookThrough(() => tinyFund, "SPY")]]), meta: new Map() });
  const texts = h.warnings.map((w) => w.text);
  expect(texts.find((t) => t.startsWith("SOFI is "))).toContain("through SPY <0.1%");
  expect(texts.some((t) => t.startsWith("SOFI on its own"))).toBe(false);
});

test("today's change only counts prices from today, and says which were left out", () => {
  const today = Date.parse("2026-11-05T15:00:00Z");
  const fresh = (value: number): Sourced => ({ value, source: "Finnhub · real-time", asOf: today - 60_000, tone: "live" });
  const h = portfolioHealth({
    positions: [
      pos({ key: "AAPL", quantity: 10, price: fresh(200), prevClose: 198 }),
      pos({ key: "VFV.TO", quantity: 20, price: eod(70), prevClose: 69, listingCcy: "CAD", bookCcy: "CAD", kind: "etf" }),
    ],
    fx,
    lookThrough: new Map(),
    meta: new Map(),
    now: today,
  });
  // Only AAPL's move: 10 × 2 × 1.40 = 28 on 10 × 198 × 1.40.
  expect(h.dayCad!.value).toBeCloseTo(28, 9);
  expect(h.dayPct!).toBeCloseTo((28 / 2772) * 100, 9);
  expect(h.dayOf).toBe("2026-11-05");
  expect(h.warnings.map((w) => w.text)).toContain("1 holding isn't in today's change because its price is from an earlier day: VFV.TO (close of Nov 4).");
  // On a Saturday the latest session is the "day", and nothing is left out.
  const sat = portfolioHealth({ positions: POSITIONS, fx, lookThrough: LT, meta, now: Date.parse("2026-11-07T17:00:00Z") });
  expect(sat.dayOf).toBe("2026-11-04");
  expect(sat.dayCad!.value).toBeCloseTo(76, 9);
});

test("unpriced holdings point to the market data settings", () => {
  const h = health({ positions: [...POSITIONS, pos({ key: "QBTS", quantity: 3 })] });
  const w = h.warnings.find((x) => x.kind === "unpriced")!;
  expect(w.link).toBe("/settings");
});

test("the day change values yesterday's holdings at yesterday's rate", () => {
  const prev: Sourced = { ...fx, value: 1.38, source: "Bank of Canada · Nov 3" };
  const h = portfolioHealth({ positions: [POSITIONS[0]!], fx, fxPrev: prev, lookThrough: new Map(), meta: new Map() });
  // 10 × 200 × 1.40 − 10 × 198 × 1.38 = 2800 − 2732.4.
  expect(h.dayCad!.value).toBeCloseTo(67.6, 9);
  expect(h.dayPct!).toBeCloseTo((67.6 / 2732.4) * 100, 9);
});
