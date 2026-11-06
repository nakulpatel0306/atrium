import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../../src/engine/db";
import { dailyBudget } from "../../../src/engine/markets/budget";
import { tsxHolidays, tsxOpen } from "../../../src/engine/markets/calendar";
import { YAHOO_BACKOFF_MS, yahooProvider } from "../../../src/engine/markets/providers/yahoo";
import { ProviderError } from "../../../src/engine/markets/providers/types";
import { tempHome } from "../../helpers";
import { fixture, jsonResponse, stubFetch } from "./fakes";

// The fixture's last trade: Fri Nov 6 2026, 12:18:45 PM ET.
const TRADE = Date.parse("2026-11-06T17:18:45Z");
let now = TRADE + 60_000;
const XEQT = { symbol: "XEQT", exchange: "TSX" as const };
const VFV = { symbol: "VFV", exchange: "TSX" as const };
let home: ReturnType<typeof tempHome>;
let db: Database;

beforeEach(() => {
  home = tempHome();
  db = openDb();
  now = TRADE + 60_000;
});
afterEach(() => {
  db.close();
  home.cleanup();
});

const provider = (f: typeof fetch, limit = 2000) => yahooProvider({ budget: dailyBudget(db, "yahoo", limit, () => now), cap: limit, fetch: f, now: () => now });
const chart = () => jsonResponse(fixture("yahoo-chart.json"));

const err = async (p: Promise<unknown>) => {
  const e = (await p.catch((x) => x)) as ProviderError;
  expect(e).toBeInstanceOf(ProviderError);
  return e;
};

test("parses the chart meta into a quote", async () => {
  const f = stubFetch(chart);
  const p = provider(f.fetch);
  expect(await p.quotes([XEQT])).toEqual([{ key: "XEQT.TO", price: 44.46, prevClose: 43.95, at: TRADE, source: "yahoo", freshness: "live" }]);
  expect(p.label).toBe("Yahoo Finance");
});

test("sends only the ticker, with a generic browser User-Agent and no key", async () => {
  const f = stubFetch(chart);
  await provider(f.fetch).quotes([XEQT]);
  const { url, headers } = f.calls[0]!;
  expect(url.origin).toBe("https://query1.finance.yahoo.com");
  expect(url.pathname).toBe("/v8/finance/chart/XEQT.TO");
  expect([...url.searchParams.keys()].sort()).toEqual(["interval", "range"]);
  expect(Object.keys(headers).sort()).toEqual(["accept", "user-agent"]);
  expect(headers["user-agent"]).toMatch(/^Mozilla\/5\.0 \(Macintosh/);
  expect(headers["user-agent"]).not.toMatch(/@|atrium|nakul/i);
});

test("covers only Canadian listings", () => {
  const p = provider(stubFetch(chart).fetch);
  expect(p.covers({ symbol: "XEQT", exchange: "TSX" })).toBe(true);
  expect(p.covers({ symbol: "ATZ", exchange: "TSX" })).toBe(true);
  expect(p.covers({ symbol: "ABC", exchange: "TSXV" })).toBe(true);
  for (const exchange of ["US", "NEO", "OTC"] as const) expect(p.covers({ symbol: "SPY", exchange })).toBe(false);
});

test("a TSX-V listing is asked for with Yahoo's .V suffix", async () => {
  const f = stubFetch(chart);
  await provider(f.fetch).quotes([{ symbol: "ABC", exchange: "TSXV" }]);
  expect(f.calls[0]!.url.pathname).toBe("/v8/finance/chart/ABC.V");
});

test("a trade older than 20 minutes isn't called live", async () => {
  now = TRADE + 21 * 60_000;
  const [q] = await provider(stubFetch(chart).fetch).quotes([XEQT]);
  expect(q!.freshness).toBe("eod");
});

test("TSX hours: weekdays 9:30 to 4:00 ET, closed on Canadian holidays", () => {
  expect(tsxOpen(Date.parse("2026-11-06T14:30:00Z"))).toBe(true);
  expect(tsxOpen(Date.parse("2026-11-06T14:29:00Z"))).toBe(false);
  expect(tsxOpen(Date.parse("2026-11-06T20:59:00Z"))).toBe(true);
  expect(tsxOpen(Date.parse("2026-11-06T21:00:00Z"))).toBe(false);
  expect(tsxOpen(Date.parse("2026-11-07T17:00:00Z"))).toBe(false);
  expect(tsxOpen(Date.parse("2026-11-08T17:00:00Z"))).toBe(false);
  // Canadian Thanksgiving trades in New York but not Toronto; US Thanksgiving is the reverse.
  expect(tsxOpen(Date.parse("2026-10-12T16:00:00Z"))).toBe(false);
  expect(tsxOpen(Date.parse("2026-11-26T17:00:00Z"))).toBe(true);
  expect(tsxHolidays(2026).map((h) => h.date)).toEqual([
    "2026-01-01", "2026-02-16", "2026-04-03", "2026-05-18", "2026-07-01",
    "2026-08-03", "2026-09-07", "2026-10-12", "2026-12-25", "2026-12-28",
  ]);
  // A weekend Christmas moves to Monday and Boxing Day to Tuesday.
  expect(tsxHolidays(2027).map((h) => h.date)).toContain("2027-12-27");
  expect(tsxHolidays(2027).map((h) => h.date)).toContain("2027-12-28");
});

test("no calls outside TSX hours, on weekends or on holidays", async () => {
  const f = stubFetch(chart);
  const p = provider(f.fetch);
  for (const at of ["2026-11-06T13:00:00Z", "2026-11-06T21:30:00Z", "2026-11-07T17:00:00Z", "2026-11-08T17:00:00Z", "2026-10-12T16:00:00Z"]) {
    now = Date.parse(at);
    expect(p.live()).toBe(false);
    expect(await p.quotes([XEQT])).toEqual([]);
  }
  expect(f.calls).toHaveLength(0);
});

test("HTTP 429 pauses Yahoo for 15 minutes and says so", async () => {
  const f = stubFetch(() => new Response("Too Many Requests", { status: 429 }));
  const p = provider(f.fetch);
  const e = await err(p.quotes([XEQT, VFV]));
  expect(e.kind).toBe("rate_limited");
  expect(e.message).toBe("Yahoo Finance says too many requests. TSX prices show the last close; Atrium tries again in 15 minutes.");
  expect(e.retryAfter).toBe(now + YAHOO_BACKOFF_MS);
  expect(f.calls).toHaveLength(1);
  expect(p.live()).toBe(false);
  expect(p.pausedUntil()).toBe(now + YAHOO_BACKOFF_MS);
  now += YAHOO_BACKOFF_MS - 1;
  expect(await p.quotes([XEQT])).toEqual([]);
  expect(f.calls).toHaveLength(1);
  now += 1;
  expect(p.live()).toBe(true);
});

test("the pause is kept wherever the caller stores it", async () => {
  let stored = 0;
  const pause = { get: () => stored, set: (until: number) => void (stored = until) };
  const make = (f: typeof fetch) => yahooProvider({ budget: dailyBudget(db, "yahoo", 2000, () => now), cap: 2000, fetch: f, now: () => now, pause });
  await err(make(stubFetch(() => new Response("", { status: 429 })).fetch).quotes([XEQT]));
  expect(stored).toBe(now + YAHOO_BACKOFF_MS);
  const f = stubFetch(chart);
  const again = make(f.fetch);
  expect(again.live()).toBe(false);
  expect(again.pausedUntil()).toBe(stored);
  expect(await again.quotes([XEQT])).toEqual([]);
  expect(f.calls).toHaveLength(0);
});

test("network and server errors back off too", async () => {
  const down = (async () => {
    throw new Error("fetch failed");
  }) as unknown as typeof fetch;
  const p = provider(down);
  expect((await err(p.quotes([XEQT]))).message).toBe("Couldn't reach Yahoo Finance. TSX prices show the last close; Atrium tries again in 15 minutes.");
  expect(p.live()).toBe(false);
  const p2 = provider(stubFetch(() => new Response("oops", { status: 502 })).fetch);
  expect((await err(p2.quotes([XEQT]))).message).toBe("Yahoo Finance returned an error (HTTP 502). TSX prices show the last close; Atrium tries again in 15 minutes.");
  expect(p2.live()).toBe(false);
});

test("a reply that changes shape gives a clear error and backs off", async () => {
  const SHAPE = "Yahoo Finance's reply changed shape, so Atrium can't read TSX prices from it. Showing the last close; Atrium tries again in 15 minutes.";
  for (const body of [{ chart: { result: [{ meta: { currency: "CAD", regularMarketPrice: "44.46" } }] } }, { quoteResponse: {} }, "<html>consent</html>"]) {
    const p = provider(stubFetch(() => jsonResponse(body)).fetch);
    const e = await err(p.quotes([XEQT]));
    expect(e.kind).toBe("unavailable");
    expect(e.message).toBe(SHAPE);
    expect(p.live()).toBe(false);
  }
});

test("an unknown ticker is skipped without pausing the rest", async () => {
  const notFound = { chart: { result: null, error: { code: "Not Found", description: "No data found, symbol may be delisted" } } };
  const f = stubFetch((url) => (url.pathname.endsWith("/NOPE.TO") ? jsonResponse(notFound, 404) : chart()));
  const p = provider(f.fetch);
  const got = await p.quotes([{ symbol: "NOPE", exchange: "TSX" }, XEQT]);
  expect(got.map((q) => q.key)).toEqual(["XEQT.TO"]);
  expect(p.live()).toBe(true);
});

test("a price quoted in another currency is not used", async () => {
  const body = JSON.parse(fixture("yahoo-chart.json"));
  body.chart.result[0].meta.currency = "USD";
  expect(await provider(stubFetch(() => jsonResponse(body)).fetch).quotes([XEQT])).toEqual([]);
});

test("Atrium's own daily cap stops requests", async () => {
  const f = stubFetch(chart);
  const p = provider(f.fetch, 2);
  await p.quotes([XEQT, VFV]);
  expect(p.live()).toBe(false);
  const e = await err(p.quotes([XEQT]));
  expect(e.kind).toBe("rate_limited");
  expect(e.message).toBe("Atrium's own cap of 2 Yahoo Finance requests today is reached. TSX prices show the last close until tomorrow.");
  expect(f.calls).toHaveLength(2);
});

test("no price history from Yahoo", async () => {
  expect((await err(provider(stubFetch(chart).fetch).bars(XEQT, "1Day", 0, now))).kind).toBe("no_history");
});
