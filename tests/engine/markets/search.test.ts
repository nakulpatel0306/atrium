import { beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ProviderError, type MarketProvider, type SearchHit } from "../../../src/engine/markets/providers/types";
import { clearSearchCache, finnhubHits, mapFinnhubSymbol, searchSymbols, typedKey } from "../../../src/engine/markets/search";

const DIR = join(import.meta.dir, "../../fixtures/markets/simple");
const raw = (name: string) => JSON.parse(readFileSync(join(DIR, `finnhub-search-${name}.json`), "utf8")) as { result: { description: string; symbol: string; type: string }[] };

// A provider that answers with the fixture rows mapped the way the Finnhub adapter maps them.
function fake(answer: (q: string) => { description: string; symbol: string; type: string }[] | Error) {
  const calls: string[] = [];
  const p = {
    id: "finnhub",
    async search(q: string) {
      calls.push(q);
      const a = answer(q);
      if (a instanceof Error) throw a;
      return finnhubHits(a);
    },
  } as unknown as MarketProvider;
  return { p, calls };
}

beforeEach(() => clearSearchCache());

test("Finnhub rows map to US and Canadian listings, foreign ones dropped", async () => {
  const f = fake((q) => raw(q).result);
  const aritzia = await searchSymbols(f.p, "aritzia");
  expect(aritzia.hits[0]).toMatchObject({ key: "ATZ.TO", exchange: "TSX", name: "Aritzia Inc" });
  const mars = await searchSymbols(f.p, "mars");
  const m = mars.hits.find((h) => h.key === "MARS")!;
  expect(m.exchange).toBe("US");
  expect(m.name).toContain("Roundhill");
  expect(m.name).toBe("Roundhill Space & Technology ETF");
  expect(mars.hits.map((h) => h.key)).toEqual(["MARS"]);
  const apple = await searchSymbols(f.p, "apple");
  expect(apple.hits.map((h) => h.key)).toEqual(["AAPL"]);
  expect(apple.note).toBeNull();
});

test("mapFinnhubSymbol", () => {
  expect(mapFinnhubSymbol("BRK.B")).toEqual({ symbol: "BRK.B", exchange: "US" });
  expect(mapFinnhubSymbol("BBD.B.TO")).toEqual({ symbol: "BBD.B", exchange: "TSX" });
  expect(mapFinnhubSymbol("SHOP.V")).toEqual({ symbol: "SHOP", exchange: "TSXV" });
  expect(mapFinnhubSymbol("ABC.NE")).toEqual({ symbol: "ABC", exchange: "NEO" });
  expect(mapFinnhubSymbol("AAPL")).toEqual({ symbol: "AAPL", exchange: "US" });
  expect(mapFinnhubSymbol("APC.DE")).toBeNull();
  expect(mapFinnhubSymbol("2A4.F")).toBeNull();
  expect(mapFinnhubSymbol("MARS.L")).toBeNull();
  expect(mapFinnhubSymbol("AAPL.SW")).toBeNull();
});

test("a typed TSX key is offered with a note, once", async () => {
  expect(typedKey("aapl")).toBeNull();
  expect(typedKey("NEO:ABC")).toMatchObject({ key: "ABC.NE", note: "Not in Finnhub's search. No free source prices NEO listings." });
  expect(typedKey("TSXV:ABC")?.key).toBe("ABC.V");
  const empty = fake(() => []);
  const r = await searchSymbols(empty.p, "TSX:XEQT");
  expect(r.hits).toEqual([
    { key: "XEQT.TO", symbol: "XEQT", exchange: "TSX", name: "XEQT.TO", type: "typed", note: "Not in Finnhub's search. Atrium prices it from Yahoo Finance during TSX hours." } satisfies SearchHit,
  ]);
  const xeqt = fake(() => raw("xeqt").result);
  const r2 = await searchSymbols(xeqt.p, "xeqt.to");
  expect(r2.hits).toHaveLength(1);
  expect(r2.hits[0]).toMatchObject({ key: "XEQT.TO", note: null, type: "ETF" });
});

test("input is validated with a plain sentence", async () => {
  const f = fake(() => []);
  await expect(searchSymbols(f.p, "")).rejects.toThrow("Type a name or a symbol.");
  await expect(searchSymbols(f.p, "   ")).rejects.toThrow("Type a name or a symbol.");
  await expect(searchSymbols(f.p, "x".repeat(41))).rejects.toThrow("Keep the search under 40 characters.");
  expect(f.calls).toEqual([]);
});

test("rate limits read plainly and aren't cached; successes are", async () => {
  let t = 0;
  const busy = fake(() => new ProviderError("rate_limited", "Finnhub's limit is reached."));
  const r = await searchSymbols(busy.p, "tesla", () => t);
  expect(r).toEqual({ hits: [], note: "Finnhub is busy. Try again in a minute." });
  t += 60_000;
  await searchSymbols(busy.p, "tesla", () => t);
  expect(busy.calls).toHaveLength(2);
  const auth = fake(() => new ProviderError("auth", "Finnhub rejected the token. Check it in Settings → Market data. token=abc123"));
  expect((await searchSymbols(auth.p, "x")).note).toBe("Finnhub rejected the token. Check it in Settings → Market data. token=[redacted]");
  const down = fake(() => new Error("socket hang up"));
  expect((await searchSymbols(down.p, "y")).note).toBe("Finnhub didn't answer. Try again in a minute.");
  const ok = fake((q) => raw(q).result);
  await searchSymbols(ok.p, "apple", () => t);
  await searchSymbols(ok.p, "Apple ", () => t + 5 * 60_000);
  expect(ok.calls).toHaveLength(1);
  await searchSymbols(ok.p, "apple", () => t + 11 * 60_000);
  expect(ok.calls).toHaveLength(2);
});

test("no provider asks for the key", async () => {
  expect(await searchSymbols(null, "aritzia")).toEqual({ hits: [], note: "Add your Finnhub key in Settings → Market data to search by name." });
  const typed = await searchSymbols(null, "XEQT.TO");
  expect(typed.hits.map((h) => h.key)).toEqual(["XEQT.TO"]);
});
