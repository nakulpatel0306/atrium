import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../../src/engine/db";
import { createSpace } from "../../../src/engine/spaces";
import { setSetting } from "../../../src/engine/settings";
import { dataBudget } from "../../../src/engine/markets/budget";
import { cachedQuotes, saveQuotes } from "../../../src/engine/markets/cache";
import { createMarketData, currentQuote } from "../../../src/engine/markets/data";
import { addHolding } from "../../../src/engine/markets/holdings";
import type { Instrument } from "../../../src/engine/markets/instrument";
import type { Keychain } from "../../../src/engine/markets/keychain";
import { freshnessText } from "../../../src/engine/markets/labels";
import { healthFor } from "../../../src/engine/markets/portfolio";
import type { Quote } from "../../../src/engine/markets/providers/types";
import { mixLabel, quoteSourced } from "../../../src/engine/markets/sourced";
import { tempHome } from "../../helpers";
import { fixture, jsonResponse, stubFetch } from "./fakes";

// The Yahoo fixture's last trade: Fri Nov 6 2026, 12:18:45 PM ET.
const TRADE = Date.parse("2026-11-06T17:18:45Z");
const SATURDAY = Date.parse("2026-11-07T17:00:00Z");
let now = TRADE + 60_000;
let home: ReturnType<typeof tempHome>;
let db: Database;

const XEQT: Instrument = { symbol: "XEQT", exchange: "TSX" };
const VFV: Instrument = { symbol: "VFV", exchange: "TSX" };
const ATZ: Instrument = { symbol: "ATZ", exchange: "TSX" };
const AAPL: Instrument = { symbol: "AAPL", exchange: "US" };

beforeEach(() => {
  home = tempHome();
  db = openDb();
  now = TRADE + 60_000;
  setSetting(db, "markets.provider", "finnhub");
});
afterEach(() => {
  db.close();
  home.cleanup();
});

const keychain = (keys: Record<string, string>): Keychain => ({ get: async (a) => keys[a] ?? null, set: async () => {}, remove: async () => {} });
const FH = { "finnhub.token": "FHTEST12345" };
const FH_AV = { ...FH, "alphavantage.key": "AVTEST12345" };

// One fake internet: Finnhub, Alpha Vantage and Yahoo each answer from fixtures; anything else fails the test.
function world(yahoo: (url: URL) => Response = () => jsonResponse(fixture("yahoo-chart.json"))) {
  return stubFetch((url) => {
    if (url.host === "finnhub.io") return jsonResponse(fixture("finnhub-quote.json"));
    if (url.host === "www.alphavantage.co") return jsonResponse(fixture("av-daily-shop.json"));
    if (url.host === "query1.finance.yahoo.com") return yahoo(url);
    throw new Error(`unexpected request to ${url.host}`);
  });
}
const yahooCalls = (f: ReturnType<typeof world>) => f.calls.filter((c) => c.url.host === "query1.finance.yahoo.com");
const make = (f: ReturnType<typeof world>, keys: Record<string, string> = FH_AV) => createMarketData({ db, keychain: keychain(keys), fetch: f.fetch, now: () => now });

const avClose = (key: string, at: number): Quote => ({ key, price: 43.95, prevClose: 43.5, at, source: "alphavantage", freshness: "eod" });

test("only Canadian listings go to Yahoo, and only their tickers", async () => {
  const f = world();
  const data = make(f);
  const r = await data.quotes([AAPL, XEQT, VFV, ATZ, { symbol: "AAPL", exchange: "NEO" }]);
  expect(yahooCalls(f).map((c) => c.url.pathname)).toEqual(["/v8/finance/chart/XEQT.TO", "/v8/finance/chart/VFV.TO", "/v8/finance/chart/ATZ.TO"]);
  expect(f.calls.filter((c) => c.url.host === "finnhub.io").map((c) => c.url.searchParams.get("symbol"))).toEqual(["AAPL"]);
  expect(f.calls.some((c) => c.url.host === "www.alphavantage.co")).toBe(false);
  expect(r.quotes.filter((q) => q.source === "yahoo").map((q) => q.key)).toEqual(["XEQT.TO", "VFV.TO", "ATZ.TO"]);
  const row = db.query("SELECT price, source, freshness FROM market_quotes WHERE key = 'XEQT.TO'").get();
  expect(row).toEqual({ price: 44.46, source: "yahoo", freshness: "live" });
  expect(data.providerFor(XEQT)?.id).toBe("yahoo");
  expect(currentQuote(db, data, XEQT)?.source).toBe("yahoo");
});

test("no Yahoo calls outside TSX hours or on weekends; Alpha Vantage's close is used instead", async () => {
  const f = world();
  const data = make(f);
  await data.reload();
  for (const at of [SATURDAY, Date.parse("2026-11-06T21:30:00Z"), Date.parse("2026-11-06T13:00:00Z")]) {
    now = at;
    expect(data.providerFor(XEQT)?.id).toBe("alphavantage");
  }
  await data.quotes([XEQT]);
  expect(yahooCalls(f)).toHaveLength(0);
  expect(f.calls.filter((c) => c.url.host === "www.alphavantage.co")).toHaveLength(1);

  const noAv = world();
  const plain = make(noAv, FH);
  now = SATURDAY;
  const r = await plain.quotes([XEQT]);
  expect(yahooCalls(noAv)).toHaveLength(0);
  expect(r.missing[0]!.key).toBe("XEQT.TO");
});

test("charts for Canadian listings stay on Alpha Vantage during the day", async () => {
  const f = world();
  const data = make(f);
  await data.bars(XEQT, "1M");
  await data.bars(XEQT, "5D");
  expect(yahooCalls(f)).toHaveLength(0);
});

test("price now is the newer of Yahoo's intraday price and Alpha Vantage's close", async () => {
  saveQuotes(db, [avClose("XEQT.TO", Date.parse("2026-11-05T21:00:00Z"))]);
  const f = world();
  const data = make(f);
  await data.quotes([XEQT]);
  expect(cachedQuotes(db, ["XEQT.TO"]).get("XEQT.TO")!.source).toBe("yahoo");

  // At 4:30 Alpha Vantage still has only Nov 4's close (the fixture), so Yahoo's Friday price stays.
  now = Date.parse("2026-11-06T21:30:00Z");
  const r = await data.quotes([{ symbol: "SHOP", exchange: "TSX" }, XEQT]);
  expect(r.quotes.find((q) => q.key === "XEQT.TO")!.source).toBe("yahoo");
  expect(cachedQuotes(db, ["XEQT.TO"]).get("XEQT.TO")!.source).toBe("yahoo");
  expect(currentQuote(db, data, XEQT)!.price).toBe(44.46);

  // A newer close replaces it.
  saveQuotes(db, [avClose("VFV.TO", Date.parse("2026-11-05T21:00:00Z"))]);
  expect(currentQuote(db, data, VFV)!.source).toBe("alphavantage");
});

test("a Yahoo trade older than 20 minutes falls back to the stored close", async () => {
  saveQuotes(db, [avClose("XEQT.TO", Date.parse("2026-11-05T21:00:00Z"))]);
  now = TRADE + 25 * 60_000;
  const data = make(world());
  const r = await data.quotes([XEQT]);
  expect(r.quotes[0]!.source).toBe("alphavantage");
  expect(cachedQuotes(db, ["XEQT.TO"]).get("XEQT.TO")!.source).toBe("alphavantage");
});

test("when Yahoo fails, the portfolio keeps the last close and the data page says why", async () => {
  saveQuotes(db, [avClose("XEQT.TO", Date.parse("2026-11-05T21:00:00Z"))]);
  const f = world(() => new Response("Too Many Requests", { status: 429 }));
  const data = make(f);
  const r = await data.quotes([XEQT, VFV]);
  const why = "Yahoo Finance says too many requests. TSX prices show the last close; Atrium tries again in 15 minutes.";
  expect(r.missing).toEqual([
    { key: "XEQT.TO", reason: why },
    { key: "VFV.TO", reason: why },
  ]);
  expect(dataBudget(db, now).find((s) => s.source === "yahoo")).toMatchObject({ label: "Yahoo Finance", callsToday: 1, lastError: why });
  expect(currentQuote(db, data, XEQT)!.source).toBe("alphavantage");
  // Paused: Canadian prices go back to Alpha Vantage's close and Yahoo isn't asked again.
  expect(data.providerFor(XEQT)?.id).toBe("alphavantage");
  expect((await data.status()).ca.message).toStartWith("Yahoo Finance paused until 12:34 PM ET after an error; after the close, Alpha Vantage");
  now += 5 * 60_000;
  await data.quotes([XEQT]);
  expect(yahooCalls(f)).toHaveLength(1);
});

test("a changed reply shows a plain error on the data page", async () => {
  const data = make(world(() => jsonResponse({ chart: { result: [{ meta: { price: 44.46 } }], error: null } })));
  await data.quotes([XEQT]);
  expect(dataBudget(db, now).find((s) => s.source === "yahoo")!.lastError).toBe(
    "Yahoo Finance's reply changed shape, so Atrium can't read TSX prices from it. Showing the last close; Atrium tries again in 15 minutes.",
  );
});

test("totals include TSX holdings priced by Yahoo, with no Alpha Vantage key", async () => {
  const spaceId = createSpace(db, { name: "TFSA", kind: "markets", goal: "invest" }).id;
  for (const [symbol, quantity] of [["XEQT", 100], ["VFV", 10]] as const) {
    addHolding(db, spaceId, { account: "TFSA", symbol, exchange: "TSX", name: symbol, quantity, bookValue: 1000, currency: "CAD" });
  }
  const data = make(world(), FH);
  await data.quotes([XEQT, VFV]);
  const h = healthFor(db, data, spaceId, now);
  expect(h.totalCad!.value).toBeCloseTo(110 * 44.46, 6);
  expect(h.totalCad!.source).toBe("Yahoo Finance · a few minutes delayed");
  expect(h.totalCad!.tone).toBe("delayed");
  expect(h.warnings.some((w) => w.kind === "unpriced")).toBe(false);
  // After the close and without an Alpha Vantage key, the day's last Yahoo price still counts.
  now = SATURDAY;
  expect(data.providerFor(XEQT)).toBeNull();
  expect(healthFor(db, data, spaceId, now).totalCad!.value).toBeCloseTo(110 * 44.46, 6);
  // Demo mode never shows a real price.
  setSetting(db, "markets.provider", "demo");
  expect(currentQuote(db, data, XEQT)).toBeNull();
});

test("the source label says Yahoo is a few minutes delayed, never real-time", () => {
  const q: Quote = { key: "XEQT.TO", price: 44.46, prevClose: 43.95, at: TRADE, source: "yahoo", freshness: "live" };
  expect(freshnessText(q, TRADE + 60_000)).toBe("Yahoo Finance · a few minutes delayed");
  expect(quoteSourced(q, TRADE + 60_000)).toMatchObject({ source: "Yahoo Finance · a few minutes delayed", tone: "delayed" });
  expect(freshnessText(q, TRADE + 30 * 60_000)).toBe("Yahoo Finance as of 12:18 PM ET");
  const last = { ...q, at: Date.parse("2026-11-06T20:59:30Z") };
  expect(freshnessText(last, SATURDAY)).toBe("Yahoo Finance · close of Nov 6");
  const us = quoteSourced({ ...q, key: "AAPL", source: "finnhub" }, TRADE + 60_000);
  expect(mixLabel([quoteSourced(q, TRADE + 60_000), us]).text).toBe("1 a few minutes delayed · 1 real-time");
});
