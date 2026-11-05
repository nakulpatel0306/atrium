import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../../src/engine/db";
import { dailyBudget } from "../../../src/engine/markets/budget";
import { alphaVantageProvider } from "../../../src/engine/markets/providers/alphavantage";
import { ProviderError } from "../../../src/engine/markets/providers/types";
import { tempHome } from "../../helpers";
import { fixture, jsonResponse, stubFetch } from "./fakes";

const KEY = "CANARYav123";
const NOW = Date.parse("2026-11-05T22:00:00Z");
const SHOP = { symbol: "SHOP", exchange: "TSX" as const };
let home: ReturnType<typeof tempHome>;
let db: Database;

beforeEach(() => {
  home = tempHome();
  db = openDb();
});
afterEach(() => {
  db.close();
  home.cleanup();
});

const provider = (f: typeof fetch, limit = 25) => alphaVantageProvider(KEY, { budget: dailyBudget(db, "alphavantage", limit, () => NOW), fetch: f, now: () => NOW });

const err = async (p: Promise<unknown>) => {
  const e = (await p.catch((x) => x)) as ProviderError;
  expect(e).toBeInstanceOf(ProviderError);
  expect(e.message).not.toContain(KEY);
  return e;
};

test("quotes come from the last two daily closes", async () => {
  const f = stubFetch(() => jsonResponse(fixture("av-daily-shop.json")));
  const p = provider(f.fetch);
  expect(await p.quotes([SHOP])).toEqual([
    { key: "SHOP.TO", price: 153.9, prevClose: 150.75, at: Date.parse("2026-11-04T21:00:00Z"), source: "alphavantage", freshness: "eod" },
  ]);
  const q = f.calls[0]!.url.searchParams;
  expect(f.calls[0]!.url.host).toBe("www.alphavantage.co");
  expect(q.get("symbol")).toBe("SHOP.TRT");
  expect(q.get("function")).toBe("TIME_SERIES_DAILY");
  expect(q.get("outputsize")).toBe("compact");
  expect(p.covers({ symbol: "X", exchange: "TSXV" })).toBe(true);
  expect(p.covers({ symbol: "AAPL", exchange: "US" })).toBe(false);
  const g = stubFetch(() => jsonResponse(fixture("av-daily-shop.json")));
  await provider(g.fetch).quotes([{ symbol: "XYZ", exchange: "TSXV" }]);
  expect(g.calls[0]!.url.searchParams.get("symbol")).toBe("XYZ.TRV");
});

test("bars ascend in seconds; full output only for long ranges", async () => {
  const f = stubFetch(() => jsonResponse(fixture("av-daily-shop.json")));
  const p = provider(f.fetch);
  const bars = await p.bars(SHOP, "1Day", NOW - 30 * 86_400_000, NOW);
  expect(bars.map((b) => b.t)).toEqual(["2026-11-02", "2026-11-03", "2026-11-04"].map((d) => Date.parse(`${d}T05:00:00Z`) / 1000));
  expect(bars[2]).toEqual({ t: Date.parse("2026-11-04T05:00:00Z") / 1000, o: 151.2, h: 154.8, l: 150.1, c: 153.9, v: 1834021 });
  await p.bars(SHOP, "1Day", NOW - 365 * 86_400_000, NOW);
  expect(f.calls[1]!.url.searchParams.get("outputsize")).toBe("full");
  expect((await err(p.bars(SHOP, "5Min", NOW - 86_400_000, NOW))).kind).toBe("no_history");
});

test("rate limit and unknown symbol replies", async () => {
  const rl = await err(provider(stubFetch(() => jsonResponse(fixture("av-rate-limit.json"))).fetch).quotes([SHOP]));
  expect(rl.kind).toBe("rate_limited");
  expect(rl.retryAfter).toBe(Date.parse("2026-11-06T05:00:00Z"));
  const note = await err(provider(stubFetch(() => jsonResponse({ Note: `Thank you for using Alpha Vantage! key=${KEY}` })).fetch).quotes([SHOP]));
  expect(note.kind).toBe("rate_limited");
  const unk = await err(provider(stubFetch(() => jsonResponse(fixture("av-unknown.json"))).fetch).quotes([SHOP]));
  expect(unk.kind).toBe("unknown_symbol");
  expect(unk.message).toBe("Alpha Vantage doesn't know SHOP.TO.");
  const down = (async (u: string) => {
    throw new Error(`failed ${u}`);
  }) as unknown as typeof fetch;
  expect((await err(provider(down).quotes([SHOP]))).kind).toBe("unavailable");
});

test("the daily budget stops requests and each fetch spends one", async () => {
  const f = stubFetch(() => jsonResponse(fixture("av-daily-shop.json")));
  const p = provider(f.fetch, 2);
  await p.quotes([SHOP]);
  await p.bars(SHOP, "1Day", NOW - 86_400_000 * 10, NOW);
  const e = await err(p.quotes([SHOP]));
  expect(e.kind).toBe("rate_limited");
  expect(e.message).toBe("Alpha Vantage's free 25 requests for today are used up; Canadian prices refresh tomorrow.");
  expect(f.calls).toHaveLength(2);
});

test("budget counts 25 per ET day", () => {
  let now = Date.parse("2026-11-05T15:00:00Z");
  const b = dailyBudget(db, "alphavantage", 25, () => now);
  for (let i = 0; i < 25; i++) expect(b.spend()).toBe(true);
  expect(b.spend()).toBe(false);
  expect(b.remaining()).toBe(0);
  now = Date.parse("2026-11-06T05:30:00Z");
  expect(b.remaining()).toBe(25);
  expect(b.spend()).toBe(true);
});
