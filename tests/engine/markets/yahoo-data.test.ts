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
import { CA_NOT_PRICED, freshnessText } from "../../../src/engine/markets/labels";
import { healthFor, portfolioDay } from "../../../src/engine/markets/portfolio";
import type { Quote } from "../../../src/engine/markets/providers/types";
import { isEarlierDay, mixLabel, priceTag, quoteSourced } from "../../../src/engine/markets/sourced";
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
function world(yahoo: (url: URL) => Response = () => jsonResponse(fixture("yahoo-chart.json")), av: () => Response = () => jsonResponse(fixture("av-daily-shop.json"))) {
  return stubFetch((url) => {
    if (url.host === "finnhub.io") return jsonResponse(fixture("finnhub-quote.json"));
    if (url.host === "www.alphavantage.co") return av();
    if (url.host === "query1.finance.yahoo.com") return yahoo(url);
    throw new Error(`unexpected request to ${url.host}`);
  });
}
const yahooCalls = (f: ReturnType<typeof world>) => f.calls.filter((c) => c.url.host === "query1.finance.yahoo.com");
const make = (f: ReturnType<typeof world>, keys: Record<string, string> = FH_AV) => createMarketData({ db, keychain: keychain(keys), fetch: f.fetch, now: () => now });

// The real Yahoo reply with its last trade moved to `at` (and its price to `price`).
function yahooTrade(at: number, price = 44.46) {
  const body = JSON.parse(fixture("yahoo-chart.json"));
  body.chart.result[0].meta.regularMarketTime = at / 1000;
  body.chart.result[0].meta.regularMarketPrice = price;
  return () => jsonResponse(body);
}
// Alpha Vantage's daily series with a close for each given date.
const avSeries = (closes: Record<string, number>) => () =>
  jsonResponse({
    "Time Series (Daily)": Object.fromEntries(
      Object.entries(closes).map(([d, c]) => [d, { "1. open": String(c), "2. high": String(c), "3. low": String(c), "4. close": String(c), "5. volume": "1000" }]),
    ),
  });

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
});

test("overnight handover: Yahoo in the day, Alpha Vantage's close after it, Yahoo again on the next trade", async () => {
  let yahoo = yahooTrade(TRADE);
  const f = world(() => yahoo(), avSeries({ "2026-11-05": 43.95, "2026-11-06": 44.5 }));
  const data = make(f);
  const cached = () => cachedQuotes(db, ["XEQT.TO"]).get("XEQT.TO")!;

  await data.quotes([XEQT]);
  expect(cached()).toMatchObject({ source: "yahoo", price: 44.46 });

  // 4:30 PM: Friday's official close replaces Yahoo's last price.
  now = Date.parse("2026-11-06T21:30:00Z");
  await data.quotes([XEQT]);
  expect(cached()).toMatchObject({ source: "alphavantage", price: 44.5, at: Date.parse("2026-11-06T21:00:00Z") });

  // Monday 9:31: before XEQT trades, Yahoo still reports Friday's closing-auction print. The official close stays.
  now = Date.parse("2026-11-09T14:31:00Z");
  yahoo = yahooTrade(Date.parse("2026-11-06T21:00:05Z"), 44.52);
  const r = await data.quotes([XEQT]);
  expect(r.quotes[0]!.source).toBe("alphavantage");
  expect(cached().source).toBe("alphavantage");

  // 9:40: the first trade of the day takes over.
  now = Date.parse("2026-11-09T14:40:00Z");
  yahoo = yahooTrade(Date.parse("2026-11-09T14:39:30Z"), 44.7);
  await data.quotes([XEQT]);
  expect(cached()).toMatchObject({ source: "yahoo", price: 44.7 });
});

test("a thin listing's earlier-session trade isn't live, and the newer official close beats it", async () => {
  // VFV trades thinly: at 12:19 its last trade is still Thursday's 3:58 PM, a little before Thursday's close.
  const f = world(yahooTrade(Date.parse("2026-11-05T20:58:00Z"), 120.1), avSeries({ "2026-11-04": 119, "2026-11-05": 120.2 }));
  const data = make(f);
  await data.quotes([VFV]);
  const q = cachedQuotes(db, ["VFV.TO"]).get("VFV.TO")!;
  expect(q.source).toBe("yahoo");
  expect(quoteSourced(q, now)).toMatchObject({ source: "Yahoo Finance · last price of Nov 5", tone: "delayed" });
  // With Yahoo paused, Canadian prices route to Alpha Vantage. Its Thursday close is newer than VFV's Thursday 3:58
  // PM trade, so it replaces it.
  setSetting(db, "markets.yahoo.pausedUntil", String(now + 15 * 60_000));
  expect(data.providerFor(VFV)?.id).toBe("alphavantage");
  await data.quotes([VFV]);
  expect(cachedQuotes(db, ["VFV.TO"]).get("VFV.TO")!).toMatchObject({ source: "alphavantage", price: 120.2 });
});

test("an Alpha Vantage close never replaces a Yahoo trade from today's session", async () => {
  const f = world(yahooTrade(TRADE), avSeries({ "2026-11-04": 43.5, "2026-11-05": 43.95 }));
  const data = make(f);
  await data.quotes([XEQT]);
  setSetting(db, "markets.yahoo.pausedUntil", String(now + 15 * 60_000));
  await data.quotes([XEQT]);
  expect(cachedQuotes(db, ["XEQT.TO"]).get("XEQT.TO")!).toMatchObject({ source: "yahoo", price: 44.46 });
});

test("Monday 9:31 with no Alpha Vantage key: Friday's Yahoo trade is not live and not today's change", async () => {
  const spaceId = createSpace(db, { name: "TFSA", kind: "markets", goal: "invest" }).id;
  addHolding(db, spaceId, { account: "TFSA", symbol: "XEQT", exchange: "TSX", name: "XEQT", quantity: 100, bookValue: 1000, currency: "CAD" });
  now = Date.parse("2026-11-09T14:31:00Z");
  const data = make(world(yahooTrade(TRADE)), FH);
  await data.quotes([XEQT]);
  const q = currentQuote(db, data, XEQT)!;
  expect(q).toMatchObject({ source: "yahoo", freshness: "eod" });
  const s = quoteSourced(q, now);
  expect(s).toMatchObject({ source: "Yahoo Finance · last price of Nov 6", tone: "delayed" });
  expect(priceTag(s, now)).toBe("last price Nov 6");
  expect(isEarlierDay(priceTag(s, now))).toBe(true);
  const day = portfolioDay(db, data, spaceId, now)!;
  expect(day.dayLabel).toBe("on Fri, Nov 6");
  expect(day.mix).not.toContain("real-time");
  expect(day.closes).toBe(1);
  expect(day.movers[0]!.tag).toBe("last price Nov 6");
});

test("Yahoo stops being live at the TSX close, including early closes", () => {
  const q = (at: number): Quote => ({ key: "XEQT.TO", price: 44.46, prevClose: 43.95, at, source: "yahoo", freshness: "live", fetchedAt: at + 20_000 });
  const late = q(Date.parse("2026-11-06T20:58:00Z"));
  expect(quoteSourced(late, Date.parse("2026-11-06T20:59:30Z")).tone).toBe("live");
  expect(quoteSourced(late, Date.parse("2026-11-06T21:01:00Z"))).toMatchObject({ source: "Yahoo Finance · last price 3:58 PM", tone: "delayed" });
  const eve = q(Date.parse("2026-12-24T17:58:00Z"));
  expect(quoteSourced(eve, Date.parse("2026-12-24T17:59:30Z")).tone).toBe("live");
  expect(quoteSourced(eve, Date.parse("2026-12-24T18:01:00Z")).tone).toBe("delayed");
});

test("during TSX hours with no Alpha Vantage key, a paused or capped Yahoo says so", async () => {
  const data = make(world(() => new Response("Too Many Requests", { status: 429 })), FH);
  await data.quotes([XEQT]);
  expect(data.reasonFor(XEQT)).toBe("Yahoo Finance is paused until 12:34 PM ET after an error.");
  setSetting(db, "markets.yahoo.pausedUntil", "0");
  setSetting(db, "markets.budget.yahoo.2026-11-06", "2000");
  expect(data.reasonFor(XEQT)).toBe("Yahoo Finance stopped for today (Atrium's 2,000-request cap).");
  now = SATURDAY;
  expect(data.reasonFor(XEQT)).toBe(CA_NOT_PRICED);
});

test("a Yahoo answer in session is live however old its last trade; it goes stale 10 minutes after the fetch", async () => {
  // Measured 2026-11-06 12:14:12 ET: VFV's last trade was 12:05:02. That's thin trading, not a delayed feed.
  now = Date.parse("2026-11-06T17:14:12Z");
  const data = make(world(yahooTrade(Date.parse("2026-11-06T17:05:02Z"), 120.1)));
  await data.quotes([VFV]);
  const q = currentQuote(db, data, VFV)!;
  expect(q).toMatchObject({ source: "yahoo", freshness: "live", fetchedAt: now });
  expect(quoteSourced(q, now)).toMatchObject({ source: "Yahoo Finance · last trade 12:05 PM", tone: "live" });
  expect(quoteSourced(q, now + 10 * 60_000).tone).toBe("live");
  const stale = quoteSourced(q, now + 11 * 60_000);
  expect(stale).toMatchObject({ source: "Yahoo Finance · last price 12:05 PM", tone: "delayed" });
  expect(priceTag(stale, now + 11 * 60_000)).toBe("as of 12:05 PM");
  expect(isEarlierDay(priceTag(stale, now + 11 * 60_000))).toBe(false);
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
  expect((await data.status()).ca.message).toStartWith("Yahoo Finance is paused until 12:34 PM ET after an error; after the close, Alpha Vantage");
  now += 5 * 60_000;
  await data.quotes([XEQT]);
  expect(yahooCalls(f)).toHaveLength(1);
});

test("the 15-minute pause survives an engine restart", async () => {
  saveQuotes(db, [avClose("XEQT.TO", Date.parse("2026-11-05T21:00:00Z"))]);
  const first = world(() => new Response("Too Many Requests", { status: 429 }));
  await make(first).quotes([XEQT]);
  const pausedUntil = now + 15 * 60_000;

  // A fresh MarketData over the same database is what a restart gets.
  now += 5 * 60_000;
  const second = world();
  const restarted = make(second);
  await restarted.reload();
  expect(restarted.providerFor(XEQT)?.id).toBe("alphavantage");
  expect((await restarted.status()).ca.message).toStartWith("Yahoo Finance is paused until 12:34 PM ET after an error");
  await restarted.quotes([XEQT]);
  expect(yahooCalls(second)).toHaveLength(0);

  now = pausedUntil;
  expect(restarted.providerFor(XEQT)?.id).toBe("yahoo");
  await restarted.quotes([XEQT]);
  expect(yahooCalls(second)).toHaveLength(1);
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
  expect(h.totalCad!.source).toBe("Yahoo Finance · last trade 12:18 PM");
  expect(h.totalCad!.tone).toBe("live");
  expect(h.warnings.some((w) => w.kind === "unpriced")).toBe(false);
  // After the close and without an Alpha Vantage key, the day's last Yahoo price still counts.
  now = SATURDAY;
  expect(data.providerFor(XEQT)).toBeNull();
  const later = healthFor(db, data, spaceId, now);
  expect(later.totalCad!.value).toBeCloseTo(110 * 44.46, 6);
  // Without Alpha Vantage it's Friday's last price, never called a close.
  expect(later.totalCad!.source).toBe("Yahoo Finance · last price of Nov 6");
  // Demo mode never shows a real price.
  setSetting(db, "markets.provider", "demo");
  expect(currentQuote(db, data, XEQT)).toBeNull();
});

test("the source label shows Yahoo's last trade time and never calls it a close", () => {
  const fetchedAt = TRADE + 30_000;
  const q: Quote = { key: "XEQT.TO", price: 44.46, prevClose: 43.95, at: TRADE, source: "yahoo", freshness: "live", fetchedAt };
  expect(freshnessText(q, fetchedAt + 60_000)).toBe("Yahoo Finance · last trade 12:18 PM");
  expect(freshnessText(q, fetchedAt + 30 * 60_000)).toBe("Yahoo Finance · last price 12:18 PM");
  // The last poll before 4:00 misses the closing auction.
  const last: Quote = { ...q, at: Date.parse("2026-11-06T20:59:30Z"), fetchedAt: Date.parse("2026-11-06T20:59:40Z") };
  const sat = quoteSourced(last, SATURDAY);
  expect(sat.source).toBe("Yahoo Finance · last price of Nov 6");
  expect(priceTag(sat, SATURDAY)).toBe("last price Nov 6");
  expect(isEarlierDay(priceTag(sat, SATURDAY))).toBe(true);
  expect(mixLabel([sat, quoteSourced(avClose("VFV.TO", Date.parse("2026-11-06T21:00:00Z")), SATURDAY)]).text).toBe("1 last price of Nov 6 · 1 close of Nov 6");
});

test("Canadian copy is right with and without an Alpha Vantage key", async () => {
  const noKey = make(world(), FH);
  await noKey.reload();
  expect((await noKey.status()).ca).toEqual({ ready: true, message: "Yahoo Finance during TSX hours · add a free Alpha Vantage key for the official close" });
  const withKey = make(world());
  await withKey.reload();
  expect((await withKey.status()).ca.message).toBe("Yahoo Finance during TSX hours; after the close, Alpha Vantage · end of day (25 of 25 requests left today)");
  now = SATURDAY;
  expect(noKey.reasonFor(XEQT)).toBe(CA_NOT_PRICED);
  expect(CA_NOT_PRICED).not.toContain("Alpha Vantage");
  expect(withKey.reasonFor(XEQT)).toBeNull();
});

test("a 429 partway through keeps the prices already fetched", async () => {
  const f = world((url) => (url.pathname.endsWith("/VFV.TO") ? new Response("Too Many Requests", { status: 429 }) : jsonResponse(fixture("yahoo-chart.json"))));
  const data = make(f);
  const r = await data.quotes([XEQT, VFV, ATZ]);
  const why = "Yahoo Finance says too many requests. TSX prices show the last close; Atrium tries again in 15 minutes.";
  expect(r.quotes.map((q) => q.key)).toEqual(["XEQT.TO"]);
  expect(r.missing).toEqual([
    { key: "VFV.TO", reason: why },
    { key: "ATZ.TO", reason: why },
  ]);
  expect(cachedQuotes(db, ["XEQT.TO"]).get("XEQT.TO")!.source).toBe("yahoo");
  expect(yahooCalls(f)).toHaveLength(2);
  expect(dataBudget(db, now).find((s) => s.source === "yahoo")!.lastError).toBe(why);
  expect(data.providerFor(XEQT)?.id).toBe("alphavantage");
});

test("Settings says when Atrium's daily Yahoo cap is used up", async () => {
  setSetting(db, `markets.budget.yahoo.2026-11-06`, "2000");
  const data = make(world(), FH);
  await data.reload();
  expect(data.providerFor(XEQT)).toBeNull();
  expect((await data.status()).ca.message).toBe("Yahoo Finance stopped for today (Atrium's 2,000-request cap) · add a free Alpha Vantage key for the official close");
});
