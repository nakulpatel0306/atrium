import { expect, test } from "bun:test";
import { companyKey, lookThrough } from "../../../src/engine/markets/funds/lookthrough";
import type { FundFile, FundLine } from "../../../src/engine/markets/funds/types";

const line = (ticker: string, weight: number, kind: FundLine["kind"] = "stock"): FundLine => ({
  ticker,
  key: ticker,
  name: `${ticker} name`,
  weight,
  kind,
  sector: "Information Technology",
  country: "United States",
  currency: "USD",
  via: null,
});
const file = (fund: string, lines: FundLine[], source: FundFile["source"] = "ishares-us"): FundFile => ({ fund, source, asOf: "2026-11-03", lines, note: null });
const loader = (files: FundFile[]) => (fund: string) => files.find((f) => f.fund === fund) ?? null;
const w = (lt: ReturnType<typeof lookThrough>, company: string) => lt.exposures.find((e) => e.company === company)?.weight;

test("a fund of funds expands to its companies", () => {
  const lt = lookThrough(loader([file("A", [line("B", 0.5, "fund"), line("AAPL", 0.5)]), file("B", [line("AAPL", 0.2), line("MSFT", 0.8)])]), "A");
  expect(w(lt, "AAPL")).toBeCloseTo(0.6, 9);
  expect(w(lt, "MSFT")).toBeCloseTo(0.4, 9);
  expect(lt.coverage).toBeCloseTo(1, 9);
  expect(lt.exposures.find((e) => e.company === "AAPL")!.via).toEqual(expect.arrayContaining(["A", "B"]));
  expect(lt.sources.map((s) => [s.value, s.source, s.tone])).toEqual([
    ["A", "iShares holdings file · Nov 3", "official"],
    ["B", "iShares holdings file · Nov 3", "official"],
  ]);
  expect(lt.unavailable).toEqual([]);
});

test("a cycle doesn't loop: a fund already on the path stays a leaf", () => {
  const lt = lookThrough(loader([file("A", [line("B", 1, "fund")]), file("B", [line("A", 0.5, "fund"), line("MSFT", 0.5)])]), "A");
  expect(w(lt, "MSFT")).toBeCloseTo(0.5, 9);
  expect(lt.exposures.find((e) => e.name === "A (fund, no breakdown)")!.weight).toBeCloseTo(0.5, 9);
});

test("deeper than three levels stays a leaf", () => {
  const chain = ["A", "B", "C", "D", "E"].map((f, i, all) => file(f, i < all.length - 1 ? [line(all[i + 1]!, 1, "fund")] : [line("NVDA", 1)]));
  const lt = lookThrough(loader(chain), "A");
  expect(lt.exposures.map((e) => e.name)).toEqual(["E (fund, no breakdown)"]);
  expect(lt.coverage).toBe(0);
});

test("a sleeve without a file is a leaf and listed as unavailable", () => {
  const lt = lookThrough(loader([file("A", [line("C", 0.3, "fund"), line("AAPL", 0.7)])]), "A");
  expect(lt.exposures.find((e) => e.name === "C (fund, no breakdown)")!.weight).toBeCloseTo(0.3, 9);
  expect(lt.unavailable).toEqual([{ fund: "C", reason: "No holdings file for C" }]);
  expect(lt.coverage).toBeCloseTo(0.7, 9);
});

test("VFV.TO is shown through SPY's holdings", () => {
  const spy = file("SPY", [line("AAPL", 0.07), line("MSFT", 0.065), line("GOOG", 0.02), line("GOOGL", 0.025)], "ssga");
  const lt = lookThrough(loader([spy]), "VFV.TO");
  const direct = lookThrough(loader([spy]), "SPY");
  expect(lt.exposures).toEqual(direct.exposures);
  expect(lt.note).toBe("VFV holds Vanguard's US S&P 500 ETF, so it's shown through SPY's holdings (same index).");
  expect(lt.fund).toBe("VFV.TO");
  expect(w(direct, "GOOGL")).toBeCloseTo(0.045, 9);
  expect(direct.exposures.some((e) => e.company === "GOOG")).toBe(false);
});

test("no file at all is one opaque line", () => {
  const lt = lookThrough(() => null, "MARS");
  expect(lt.exposures).toHaveLength(1);
  expect(lt.exposures[0]).toMatchObject({ name: "MARS (fund, no breakdown)", weight: 1, kind: "fund" });
  expect(lt.unavailable).toEqual([{ fund: "MARS", reason: "No holdings file for MARS" }]);
  expect(lt.coverage).toBe(0);
});

test("companyKey folds share classes, keeps listings apart, and falls back to the name", () => {
  expect(companyKey({ ticker: "BRK/B", name: "x", country: "United States" })).toBe("BRK.B");
  expect(companyKey({ ticker: "BRK-B", name: "x", country: "United States" })).toBe("BRK.B");
  expect(companyKey({ ticker: "GOOG", name: "x", country: "United States" })).toBe("GOOGL");
  expect(companyKey({ ticker: null, name: "CXMT (ChangXin Memory, private)", country: "China" })).toBe("CXMT CHANGXIN MEMORY PRIVATE");
});

test("an estimate file is labelled as one", () => {
  const lt = lookThrough(loader([file("QQQ", [line("AAPL", 1)], "ndx-estimate")]), "QQQ");
  expect(lt.sources[0]).toMatchObject({ source: "Estimate from Nasdaq-100 members · SPY weights", tone: "estimate" });
});
