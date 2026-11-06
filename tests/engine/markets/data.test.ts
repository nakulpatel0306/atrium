import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../../src/engine/db";
import { setSetting } from "../../../src/engine/settings";
import { cachedQuotes, saveQuotes } from "../../../src/engine/markets/cache";
import { createMarketData } from "../../../src/engine/markets/data";
import { instrumentKey, type Instrument } from "../../../src/engine/markets/instrument";
import type { Keychain } from "../../../src/engine/markets/keychain";
import { demoProvider } from "../../../src/engine/markets/providers/demo";
import { ProviderError, type Bar, type MarketProvider, type Quote } from "../../../src/engine/markets/providers/types";
import { tempHome } from "../../helpers";

let home: ReturnType<typeof tempHome>;
let db: Database;
let now = Date.parse("2026-11-05T16:00:00Z");

beforeEach(() => {
  home = tempHome();
  db = openDb();
  now = Date.parse("2026-11-05T16:00:00Z");
});
afterEach(() => {
  db.close();
  home.cleanup();
});

const fakeKeychain = (keys: Record<string, string>): Keychain => ({
  get: async (a) => keys[a] ?? null,
  set: async (a, s) => {
    keys[a] = s;
  },
  remove: async (a) => {
    delete keys[a];
  },
});

const ALL_KEYS = { "alpaca.keyId": "PKTEST12345", "alpaca.secret": "SKTEST67890", "finnhub.token": "FHTEST12345", "alphavantage.key": "AVTEST12345" };

function stub(id: "finnhub" | "tiingo" | "alphavantage", opts: { fail?: string; bars?: (from: number, to: number) => Bar[] } = {}) {
  const calls: { method: string; list?: Instrument[]; from?: number; to?: number }[] = [];
  const p: MarketProvider = {
    id,
    label: id,
    covers: (i) => (id !== "alphavantage" ? i.exchange === "US" : i.exchange === "TSX" || i.exchange === "TSXV"),
    async quotes(list) {
      calls.push({ method: "quotes", list });
      if (opts.fail) throw new ProviderError("unavailable", opts.fail);
      return list.map((i): Quote => ({ key: instrumentKey(i), price: 100, prevClose: 99, at: now, source: id, freshness: id === "finnhub" ? "live" : "eod" }));
    },
    async bars(_i, _tf, from, to) {
      calls.push({ method: "bars", from, to });
      return opts.bars ? opts.bars(from, to) : [];
    },
    async validate() {},
  };
  return { p, calls };
}

test("NEO CDR is never priced from the US feed", async () => {
  const us = stub("finnhub");
  const data = createMarketData({ db, keychain: fakeKeychain({ ...ALL_KEYS }), now: () => now, providers: { finnhub: us.p } });
  const r = await data.quotes([{ symbol: "AAPL", exchange: "NEO" }, { symbol: "AAPL", exchange: "US" }]);
  expect(r.quotes.map((q) => q.key)).toEqual(["AAPL"]);
  expect(r.missing).toEqual([{ key: "AAPL.NE", reason: "No free source covers NEO-listed CDRs." }]);
  expect(us.calls[0]!.list).toEqual([{ symbol: "AAPL", exchange: "US" }]);
  expect(data.providerFor({ symbol: "AAPL", exchange: "NEO" })).toBeNull();
  expect(cachedQuotes(db, ["AAPL"]).get("AAPL")!.price).toBe(100);
});

test("no keys → every instrument missing with its reason", async () => {
  const data = createMarketData({ db, keychain: fakeKeychain({}), now: () => now, providers: { finnhub: stub("finnhub").p } });
  const r = await data.quotes([
    { symbol: "AAPL", exchange: "US" },
    { symbol: "SHOP", exchange: "TSX" },
    { symbol: "AAPL", exchange: "NEO" },
    { symbol: "GBTC", exchange: "OTC" },
  ]);
  expect(r.quotes).toEqual([]);
  expect(r.missing).toEqual([
    { key: "AAPL", reason: "Add your Finnhub key in Settings → Market data." },
    { key: "SHOP.TO", reason: "Not priced yet. Yahoo Finance fills in during TSX hours (9:30 AM to 4:00 PM ET)." },
    { key: "AAPL.NE", reason: "No free source covers NEO-listed CDRs." },
    { key: "GBTC:OTC", reason: "No free source covers OTC stocks." },
  ]);
  const s = await data.status();
  expect(s.us.ready).toBe(false);
  expect(s.keys).toEqual({ alpaca: false, finnhub: false, alphavantage: false, tiingo: false });
});

test("demo covers TSX and NEO", async () => {
  setSetting(db, "markets.provider", "demo");
  const data = createMarketData({ db, keychain: fakeKeychain({}), now: () => now, providers: { demo: demoProvider({ now: () => now }) } });
  const r = await data.quotes([{ symbol: "SHOP", exchange: "TSX" }, { symbol: "AAPL", exchange: "NEO" }]);
  expect(r.missing).toEqual([]);
  expect(r.quotes.map((q) => q.freshness)).toEqual(["demo", "demo"]);
  expect((await data.status()).us.ready).toBe(true);
  expect(data.streamer()?.id).toBe("demo");
});

test("provider error keeps the cached quote", async () => {
  saveQuotes(db, [{ key: "AAPL", price: 150, prevClose: 149, at: now - 60_000, source: "finnhub", freshness: "live" }]);
  const us = stub("finnhub", { fail: "Couldn't reach Finnhub. Check your internet connection; Atrium will try again." });
  const data = createMarketData({ db, keychain: fakeKeychain({ ...ALL_KEYS }), now: () => now, providers: { finnhub: us.p } });
  const r = await data.quotes([{ symbol: "AAPL", exchange: "US" }]);
  expect(r.missing).toEqual([{ key: "AAPL", reason: "Couldn't reach Finnhub. Check your internet connection; Atrium will try again." }]);
  expect(cachedQuotes(db, ["AAPL"]).get("AAPL")!.price).toBe(150);
});

test("daily bars are cached", async () => {
  const day = (d: string, c: number): Bar => ({ t: Date.parse(`${d}T05:00:00Z`) / 1000, o: c, h: c + 1, l: c - 1, c, v: 10 });
  const us = stub("tiingo", {
    bars: (from) => [day("2026-11-03", 10), day("2026-11-04", 11), day("2026-11-05", 12)].filter((b) => b.t * 1000 >= from - 86_400_000 && b.t * 1000 + 16 * 3_600_000 <= now),
  });
  const data = createMarketData({ db, keychain: fakeKeychain({ ...ALL_KEYS, "tiingo.token": "TGTEST12345" }), now: () => now, providers: { finnhub: us.p, tiingo: us.p } });
  const AAPL = { symbol: "AAPL", exchange: "US" as const };
  const first = await data.bars(AAPL, "1Y");
  expect(first.timeframe).toBe("1Day");
  expect(first.bars.map((b) => b.c)).toEqual([10, 11]);
  expect(first.source).toBe("tiingo");
  expect(first.freshness).toBe("eod");
  await data.bars(AAPL, "1Y");
  expect(us.calls.filter((c) => c.method === "bars")).toHaveLength(1);
  now = Date.parse("2026-11-06T16:00:00Z");
  const next = await data.bars(AAPL, "1Y");
  const barCalls = us.calls.filter((c) => c.method === "bars");
  expect(barCalls).toHaveLength(2);
  expect(barCalls[1]!.from).toBe(Date.parse("2026-11-04T05:00:00Z"));
  expect(next.bars.map((b) => b.c)).toEqual([10, 11, 12]);
  const five = await data.bars(AAPL, "5D");
  expect(five.timeframe).toBe("5Min");
  await data.bars(AAPL, "5D");
  expect(us.calls.filter((c) => c.method === "bars")).toHaveLength(4);
});

test("bars for an uncovered instrument explain why", async () => {
  const data = createMarketData({ db, keychain: fakeKeychain({}), now: () => now });
  const r = await data.bars({ symbol: "AAPL", exchange: "NEO" }, "1M");
  expect(r.bars).toEqual([]);
  expect(r.source).toBeNull();
  expect(r.note).toBe("No free source covers NEO-listed CDRs.");
});

test("secrets() lists loaded keys and reload() re-reads them", async () => {
  const keys: Record<string, string> = {};
  const data = createMarketData({ db, keychain: fakeKeychain(keys), now: () => now });
  expect(data.secrets()).toEqual([]);
  keys["finnhub.token"] = "FHTEST12345";
  await data.reload();
  expect(data.secrets()).toEqual(["FHTEST12345"]);
  expect((await data.status()).keys.finnhub).toBe(true);
});

test("a rejected key shows in the status and stops the feed asking", async () => {
  const us = stub("finnhub");
  us.p.quotes = async () => {
    throw new ProviderError("auth", "Finnhub rejected the key. Check it in Settings → Market data.");
  };
  const data = createMarketData({ db, keychain: fakeKeychain({ ...ALL_KEYS }), now: () => now, providers: { finnhub: us.p } });
  await data.quotes([{ symbol: "AAPL", exchange: "US" }]);
  expect((await data.status()).us).toEqual({ ready: false, message: "Finnhub rejected the key. Check it in Settings → Market data." });
  await data.reload();
  expect((await data.status()).us.ready).toBe(true);
});

test("keys are read again later when the Keychain was locked at boot", async () => {
  let locked = true;
  let reads = 0;
  const keys: Record<string, string> = { ...ALL_KEYS };
  const keychain: Keychain = {
    get: async (a) => {
      reads++;
      if (locked) throw new Error("locked");
      return keys[a] ?? null;
    },
    set: async () => {},
    remove: async () => {},
  };
  const data = createMarketData({ db, keychain, now: () => now, providers: { finnhub: stub("finnhub").p } });
  // status() never touches the Keychain.
  await data.status();
  expect(reads).toBe(0);
  expect((await data.quotes([{ symbol: "AAPL", exchange: "US" }])).missing).toHaveLength(1);
  expect((await data.status()).us.message).toBe("Keychain is locked. Unlock it, then press Test in Settings → Market data.");
  locked = false;
  const after = reads;
  expect((await data.quotes([{ symbol: "AAPL", exchange: "US" }])).missing).toHaveLength(1);
  expect(reads).toBe(after);
  now += 601_000;
  expect((await data.quotes([{ symbol: "AAPL", exchange: "US" }])).quotes).toHaveLength(1);
  // A user action reads straight away.
  locked = true;
  await data.refreshKeys(true);
  expect((await data.status()).us.ready).toBe(false);
});

test("a rejected key is retried once at the next session", async () => {
  const us = stub("finnhub");
  let fail = true;
  const real = us.p.quotes;
  us.p.quotes = async (list) => {
    if (fail) throw new ProviderError("auth", "Finnhub rejected the key. Check it in Settings → Market data.");
    return real(list);
  };
  const data = createMarketData({ db, keychain: fakeKeychain({ ...ALL_KEYS }), now: () => now, providers: { finnhub: us.p } });
  await data.quotes([{ symbol: "AAPL", exchange: "US" }]);
  expect((await data.status()).us.ready).toBe(false);
  await data.prepare();
  expect((await data.status()).us.ready).toBe(false);
  now = Date.parse("2026-11-06T15:00:00Z");
  fail = false;
  await data.prepare();
  expect((await data.status()).us.ready).toBe(true);
});

test("every provider request is metered, and failures are noted for the budget page", async () => {
  const { dataBudget } = await import("../../../src/engine/markets/budget");
  const { stubFetch, jsonResponse, fixture } = await import("./fakes");
  setSetting(db, "markets.provider", "finnhub");
  let fail = false;
  const s = stubFetch(() => (fail ? new Response("no", { status: 500 }) : jsonResponse(fixture("finnhub-quote.json"))));
  const data = createMarketData({ db, keychain: fakeKeychain({ ...ALL_KEYS }), fetch: s.fetch, now: () => now });
  await data.quotes([{ symbol: "AAPL", exchange: "US" }]);
  const row = () => dataBudget(db, now).find((r) => r.source === "finnhub")!;
  expect(row().callsToday).toBe(s.calls.length);
  expect(row().callsToday).toBeGreaterThan(0);
  expect(row().lastOkAt).toBe(now);
  fail = true;
  await data.quotes([{ symbol: "AAPL", exchange: "US" }]);
  expect(row().lastError).toContain("Finnhub");
  expect(row().lastError).not.toContain("FHTEST12345");
});

test("US daily history comes from Tiingo", async () => {
  const { stubFetch, jsonResponse, fixture } = await import("./fakes");
  setSetting(db, "markets.provider", "finnhub");
  now = Date.parse("2026-11-05T16:00:00Z");
  const s = stubFetch((url) => (url.host === "api.tiingo.com" ? jsonResponse(fixture("investing/tiingo-spy.json")) : new Response("no", { status: 500 })));
  const withKey = createMarketData({ db, keychain: fakeKeychain({ "finnhub.token": "FHTEST12345", "tiingo.token": "TGTEST12345" }), fetch: s.fetch, now: () => now });
  const r = await withKey.bars({ symbol: "AAPL", exchange: "US" }, "1Y");
  expect([r.source, r.freshness, r.bars.length]).toEqual(["tiingo", "eod", 10]);
  const st = await withKey.status();
  expect(st.keys.tiingo).toBe(true);
  expect(st.history).toEqual({ ready: true, message: "Tiingo · end of day (949 of 950 requests left today)" });
  db.query("DELETE FROM market_bars").run();
  db.query("DELETE FROM settings WHERE key LIKE 'markets.bars.%'").run();
  const without = createMarketData({ db, keychain: fakeKeychain({ "finnhub.token": "FHTEST12345" }), fetch: s.fetch, now: () => now });
  const none = await without.bars({ symbol: "AAPL", exchange: "US" }, "1Y");
  // Without Tiingo (optional now), the chart draws Atrium's own daily closes, which build up over time.
  expect(none.bars).toEqual([]);
  expect(none.source).toBeNull();
  expect(none.note).toBe("Atrium's own daily closes from Finnhub prices. History builds up over time.");
  expect(await without.status()).toMatchObject({ history: { ready: true, message: "Atrium's own daily closes · builds up over time" } });
  const { recordCloses } = await import("../../../src/engine/markets/closes");
  recordCloses(db, "AAPL", [{ date: "2026-11-03", close: 200, adjClose: null, source: "finnhub" }, { date: "2026-11-04", close: 202, adjClose: null, source: "finnhub" }]);
  const own = await without.bars({ symbol: "AAPL", exchange: "US" }, "1Y");
  expect(own.bars.map((b) => [b.o, b.h, b.l, b.c])).toEqual([[200, 200, 200, 200], [202, 202, 202, 202]]);
});

test("with no provider setting, US prices come from Finnhub", async () => {
  const us = stub("finnhub");
  const data = createMarketData({ db, keychain: fakeKeychain({ "finnhub.token": "FHTEST12345" }), now: () => now, providers: { finnhub: us.p } });
  expect((await data.quotes([{ symbol: "AAPL", exchange: "US" }])).quotes.map((q) => q.source)).toEqual(["finnhub"]);
  const st = await data.status();
  expect(st.usProvider).toBe("finnhub");
  expect(st.us.message).toBe("Finnhub · real-time");
});

test("US daily history comes from Tiingo even if the old setting said alpaca", async () => {
  db.query("INSERT INTO settings (key, value) VALUES ('markets.provider', 'alpaca')").run();
  const alpaca = stub("finnhub");
  const tiingo = stub("tiingo", { bars: () => [{ t: Date.parse("2026-11-04T05:00:00Z") / 1000, o: 1, h: 1, l: 1, c: 1, v: 1 }] });
  const data = createMarketData({
    db,
    keychain: fakeKeychain({ ...ALL_KEYS, "tiingo.token": "TGTEST12345" }),
    now: () => now,
    providers: { alpaca: { ...alpaca.p, id: "alpaca" }, tiingo: tiingo.p },
  });
  const r = await data.bars({ symbol: "AAPL", exchange: "US" }, "1Y");
  expect(r.source).toBe("tiingo");
  expect(alpaca.calls).toHaveLength(0);
  expect((await data.status()).usProvider).toBe("finnhub");
});
