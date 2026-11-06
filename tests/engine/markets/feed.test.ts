import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../../src/engine/db";
import { bus, type EngineEvent } from "../../../src/engine/events";
import { createSpace } from "../../../src/engine/spaces";
import { usSession } from "../../../src/engine/markets/calendar";
import type { DataStatus, MarketData } from "../../../src/engine/markets/data";
import { createFeed, feedMode, FLUSH_MS, OFF_RECHECK_MS, POLL_MS, trackedInstruments } from "../../../src/engine/markets/feed";
import { instrumentKey, type Instrument } from "../../../src/engine/markets/instrument";
import type { MarketProvider, Quote, StreamEvents } from "../../../src/engine/markets/providers/types";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createMarketData } from "../../../src/engine/markets/data";
import { createKeychain } from "../../../src/engine/markets/keychain";
import { setAdvanced } from "../../../src/engine/markets/advanced";
import { tempHome } from "../../helpers";

const FAKE_SECURITY = resolve(import.meta.dir, "../../fixtures/fake-security.ts");
import { fakeTimers } from "./fakes";

let home: ReturnType<typeof tempHome>;
let db: Database;
let now: number;
let spaceId: string;

beforeEach(() => {
  home = tempHome();
  db = openDb();
  spaceId = createSpace(db, { name: "Stocks", kind: "markets", goal: "watch" }).id;
  // Plan 7 behaviour under test is Advanced-only; the gates themselves are tested with it off.
  setAdvanced(db, spaceId, true);
});
afterEach(() => {
  db.close();
  home.cleanup();
});

const watch = (symbol: string, exchange = "US") =>
  db.query("INSERT INTO market_watchlist (space_id, symbol, exchange, name, added_at) VALUES (?, ?, ?, '', 1)").run(spaceId, symbol, exchange);

type Stream = { list: Instrument[]; ev: StreamEvents; closed: boolean; sets: Instrument[][] };

function fakeData(opts: { ready?: boolean; canStream?: boolean; barsFail?: boolean } = {}) {
  const quoteCalls: Instrument[][] = [];
  const barCalls: { key: string; range: string }[] = [];
  const streams: Stream[] = [];
  const streamer: MarketProvider = {
    id: "alpaca",
    label: "Alpaca",
    covers: () => true,
    quotes: async () => [],
    bars: async () => [],
    validate: async () => {},
    maxStreamSymbols: 30,
    stream(list, ev) {
      const s: Stream = { list, ev, closed: false, sets: [] };
      streams.push(s);
      return {
        set: (l) => void s.sets.push(l),
        close: () => {
          s.closed = true;
        },
      };
    },
  };
  const av = { ...streamer, id: "alphavantage" as const, stream: undefined };
  const data: MarketData = {
    async quotes(list) {
      quoteCalls.push(list);
      return { quotes: list.map((i): Quote => ({ key: instrumentKey(i), price: 10, prevClose: 9, at: now, source: "alpaca", freshness: "live" })), missing: [] };
    },
    async bars(i, range) {
      barCalls.push({ key: instrumentKey(i), range });
      if (opts.barsFail) throw new Error("boom");
      return { key: instrumentKey(i), timeframe: "1Day", bars: [], source: "alpaca", freshness: "live", note: null };
    },
    news: async () => [],
    streamer: () => (opts.canStream === false ? null : streamer),
    status: async (): Promise<DataStatus> => ({
      usProvider: "alpaca",
      us: { ready: opts.ready ?? true, message: opts.ready === false ? "Add your Alpaca key in Settings → Market data." : "ok" },
      ca: { ready: true, message: "ok" },
      keys: { alpaca: true, finnhub: false, alphavantage: true, tiingo: false },
      history: { ready: true, message: "ok" },
    }),
    reload: async () => {},
    prepare: async () => {},
    refreshKeys: async () => {},
    providerFor: (i) => (i.exchange === "US" ? streamer : i.exchange === "TSX" ? av : null),
    reasonFor: () => null,
    secrets: () => [],
  };
  return { data, quoteCalls, barCalls, streams };
}

function setup(at: string, opts: Parameters<typeof fakeData>[0] & { strategy?: boolean } = {}) {
  now = Date.parse(at);
  const fd = fakeData(opts);
  const timers = fakeTimers();
  const got: Quote[][] = [];
  const jobRuns: number[] = [];
  const jobs = { runDue: async (t: number) => void jobRuns.push(t) };
  const feed = createFeed({ db, data: fd.data, onQuotes: (q) => got.push(q), strategyActive: () => !!opts.strategy, now: () => now, timers, jobs });
  return { ...fd, timers, feed, got, jobRuns };
}

test("feedMode table", () => {
  const open = usSession(Date.parse("2026-11-05T15:00:00Z"));
  const closed = usSession(Date.parse("2026-11-07T15:00:00Z"));
  const base = { session: open, hasSymbols: true, ready: true, viewers: 0, strategyActive: false, canStream: true };
  expect(feedMode({ ...base, session: closed }).mode).toBe("off");
  expect(feedMode({ ...base, session: closed }).reason).toBe("Stopped · market closed until Mon 9:30 AM ET");
  expect(feedMode({ ...base, hasSymbols: false })).toEqual({ mode: "off", reason: "Stopped · no symbols to watch" });
  expect(feedMode({ ...base, ready: false }).mode).toBe("off");
  expect(feedMode({ ...base, viewers: 1 })).toEqual({ mode: "stream", reason: "Streaming · market open, dashboard open" });
  expect(feedMode({ ...base, strategyActive: true })).toEqual({ mode: "stream", reason: "Streaming · paper strategy running" });
  expect(feedMode(base)).toEqual({ mode: "poll", reason: "Checking every 3 minutes · market open" });
  expect(feedMode({ ...base, viewers: 1, canStream: false }).mode).toBe("poll");
});

test("off makes no network calls and holds one capped timer", async () => {
  watch("AAPL");
  const s = setup("2026-11-07T17:00:00Z");
  await s.feed.start();
  expect(s.quoteCalls).toHaveLength(0);
  expect(s.timers.pending.size).toBe(1);
  expect([...s.timers.pending.values()][0]!.delay).toBe(Math.min(usSession(now).nextOpen - now, OFF_RECHECK_MS));
  expect(s.feed.status().mode).toBe("off");
  now = Date.parse("2026-11-09T15:00:00Z");
  s.timers.fireAll();
  await s.feed.idle();
  expect(s.feed.status().mode).toBe("poll");
  expect(s.quoteCalls).toHaveLength(1);
  s.feed.stop();
});

test("late timer after sleep", async () => {
  watch("AAPL");
  const s = setup("2026-11-07T01:00:00Z");
  await s.feed.start();
  expect(s.feed.status().reason).toBe("Stopped · market closed until Mon 9:30 AM ET");
  now = Date.parse("2026-11-09T15:00:00Z");
  s.timers.fireAll();
  await s.feed.idle();
  expect(s.feed.status().mode).toBe("poll");
  expect(s.quoteCalls).toHaveLength(1);
  s.feed.stop();
});

test("holiday", async () => {
  watch("AAPL");
  const s = setup("2026-11-26T15:00:00Z");
  await s.feed.start();
  expect(s.feed.status()).toMatchObject({ mode: "off", reason: "Stopped · market holiday (Thanksgiving Day)" });
  expect(s.quoteCalls).toHaveLength(0);
  s.feed.stop();
});

test("not ready says why", async () => {
  watch("AAPL");
  const s = setup("2026-11-05T15:00:00Z", { ready: false });
  await s.feed.start();
  expect(s.feed.status()).toMatchObject({ mode: "off", reason: "Stopped · Add your Alpaca key in Settings → Market data." });
  expect(s.quoteCalls).toHaveLength(0);
  s.feed.stop();
});

test("poll during the session, one final call at the close, then stop", async () => {
  watch("AAPL");
  const s = setup("2026-11-05T15:00:00Z");
  await s.feed.start();
  expect(s.quoteCalls).toHaveLength(1);
  expect([...s.timers.pending.values()].map((t) => t.delay)).toEqual([POLL_MS]);
  now += POLL_MS;
  s.timers.fireAll();
  await s.feed.idle();
  expect(s.quoteCalls).toHaveLength(2);
  expect(s.got).toHaveLength(2);
  now = Date.parse("2026-11-05T21:01:00Z");
  s.timers.fireAll();
  await s.feed.idle();
  expect(s.quoteCalls).toHaveLength(3);
  expect(s.feed.status().mode).toBe("off");
  now += OFF_RECHECK_MS;
  s.timers.fireAll();
  await s.feed.idle();
  expect(s.quoteCalls).toHaveLength(3);
  s.feed.stop();
});

test("the last price at the close is kept as the day's close", async () => {
  const { closes } = await import("../../../src/engine/markets/closes");
  watch("AAPL");
  watch("MSFT");
  watch("SHOP", "TSX");
  const s = setup("2026-11-05T20:57:00Z");
  await s.feed.start();
  now = Date.parse("2026-11-05T21:00:30Z");
  s.timers.fireAll();
  await s.feed.idle();
  expect(s.feed.status().mode).toBe("off");
  const rows = db.query("SELECT key, date, close, source FROM market_closes ORDER BY key").all();
  expect(rows).toEqual([
    { key: "AAPL", date: "2026-11-05", close: 10, source: "alpaca" },
    { key: "MSFT", date: "2026-11-05", close: 10, source: "alpaca" },
  ]);
  expect(closes(db, "AAPL", "2026-11-01")).toHaveLength(1);
  s.feed.stop();
});

test("a bus change doesn't push the next poll back", async () => {
  watch("AAPL");
  const s = setup("2026-11-05T15:00:00Z");
  await s.feed.start();
  bus.emit({ type: "changed" });
  for (const [id, t] of [...s.timers.pending.entries()].filter(([, t]) => t.delay === 250)) {
    s.timers.pending.delete(id);
    t.fn();
  }
  await s.feed.idle();
  expect(s.quoteCalls).toHaveLength(1);
  expect([...s.timers.pending.values()].map((t) => t.delay)).toEqual([POLL_MS]);
  s.feed.stop();
});

test("stream the first symbols while viewed, poll the rest", async () => {
  for (let i = 0; i < 32; i++) watch(`S${String(i).padStart(2, "0")}`);
  const s = setup("2026-11-05T15:00:00Z");
  await s.feed.start();
  await s.feed.setViewers(1);
  expect(s.feed.status().mode).toBe("stream");
  expect(s.streams).toHaveLength(1);
  expect(s.streams[0]!.list).toHaveLength(30);
  now += POLL_MS;
  s.timers.fireAll();
  await s.feed.idle();
  expect(s.quoteCalls.at(-1)!.map((i) => i.symbol)).toEqual(["S30", "S31"]);
  await s.feed.setViewers(0);
  expect(s.streams[0]!.closed).toBe(true);
  expect(s.feed.status().mode).toBe("poll");
  await s.feed.setViewers(1);
  expect(s.streams).toHaveLength(2);
  s.streams[1]!.ev.status({ ok: false, message: "Alpaca allows one live connection on the free plan." });
  await s.feed.idle();
  expect(s.streams[1]!.closed).toBe(true);
  expect(s.feed.status()).toMatchObject({ mode: "poll", streamError: "Alpaca allows one live connection on the free plan." });
  s.feed.stop();
});

test("a paper strategy streams with no viewer", async () => {
  watch("AAPL");
  const s = setup("2026-11-05T15:00:00Z", { strategy: true });
  await s.feed.start();
  expect(s.feed.status().reason).toBe("Streaming · paper strategy running");
  s.feed.stop();
});

test("stream quotes flush at most once per FLUSH_MS", async () => {
  watch("AAPL");
  watch("MSFT");
  const s = setup("2026-11-05T15:00:00Z");
  await s.feed.start();
  await s.feed.setViewers(1);
  const events: EngineEvent[] = [];
  const off = bus.on((e) => events.push(e));
  const before = s.got.length;
  for (let i = 0; i < 10; i++) s.streams[0]!.ev.quote({ key: i % 2 ? "MSFT" : "AAPL", price: 100 + i, prevClose: 99, at: now + i, source: "alpaca", freshness: "live" });
  const flushes = [...s.timers.pending.entries()].filter(([, t]) => t.delay === FLUSH_MS);
  expect(flushes).toHaveLength(1);
  s.timers.pending.delete(flushes[0]![0]);
  flushes[0]![1].fn();
  off();
  expect(s.got.length - before).toBe(1);
  expect(s.got.at(-1)!.map((q) => [q.key, q.price]).sort()).toEqual([["AAPL", 108], ["MSFT", 109]]);
  expect(events.filter((e) => e.type === "quotes")).toHaveLength(1);
  const row = db.query("SELECT price FROM market_quotes WHERE key = 'MSFT'").get() as { price: number };
  expect(row.price).toBe(109);
  expect(s.feed.status().lastQuoteAt).toBe(now + 9);
  s.feed.stop();
});

test("daily bars refresh once per ET date and errors are ignored", async () => {
  watch("AAPL");
  watch("SHOP", "TSX");
  watch("AAPL", "NEO");
  const s = setup("2026-11-05T15:00:00Z", { barsFail: true });
  await s.feed.start();
  expect(s.barCalls).toEqual([{ key: "AAPL", range: "6M" }, { key: "SHOP.TO", range: "6M" }]);
  now += POLL_MS;
  s.timers.fireAll();
  await s.feed.idle();
  expect(s.barCalls).toHaveLength(2);
  s.feed.stop();
});

test("the feed leaves TSX end of day to the eod job", async () => {
  db.query("INSERT INTO market_holdings (id, space_id, account, symbol, exchange, name, quantity, currency, source, updated_at) VALUES ('h1', ?, 'TFSA', 'SHOP', 'TSX', 'Shopify', 5, 'CAD', 'manual', 1)").run(spaceId);
  const s = setup("2026-11-05T21:31:00Z");
  await s.feed.start();
  expect(s.quoteCalls).toEqual([]);
  now += OFF_RECHECK_MS;
  s.timers.fireAll();
  await s.feed.idle();
  expect(s.quoteCalls).toEqual([]);
  s.feed.stop();
});

test("jobs run from the feed's own timer and add none", async () => {
  watch("AAPL");
  const s = setup("2026-11-07T08:00:00Z"); // Sat 03:00 ET
  await s.feed.start();
  expect(s.jobRuns).toEqual([now]);
  expect(s.timers.pending.size).toBe(1);
  for (let i = 0; i < 3; i++) {
    now += OFF_RECHECK_MS;
    s.timers.fireAll();
    await s.feed.idle();
    expect(s.timers.pending.size).toBe(1);
  }
  expect(s.jobRuns).toHaveLength(4);
  expect(s.timers.delays.every((d) => d === OFF_RECHECK_MS)).toBe(true);
  s.feed.stop();
});

test("no tracked symbols: no jobs and no timer", async () => {
  const s = setup("2026-11-07T08:00:00Z");
  await s.feed.start();
  expect(s.jobRuns).toEqual([]);
  expect(s.timers.pending.size).toBe(0);
  s.feed.stop();
});

test("no markets spaces → no timer", async () => {
  db.query("UPDATE spaces SET status = 'archived'").run();
  watch("AAPL");
  const s = setup("2026-11-05T15:00:00Z");
  await s.feed.start();
  expect(s.timers.pending.size).toBe(0);
  expect(s.feed.status().reason).toBe("Stopped · no symbols to watch");
  s.feed.stop();
});

test("trackedInstruments orders and dedupes", () => {
  watch("MSFT");
  watch("AAPL");
  db.query("INSERT INTO market_holdings (id, space_id, account, symbol, exchange, name, quantity, currency, source, updated_at) VALUES ('h1', ?, 'TFSA', 'SHOP', 'TSX', 'S', 5, 'CAD', 'manual', 1)").run(spaceId);
  db.query("INSERT INTO paper_fills (id, space_id, symbol, side, qty, price, quote_at, source, actor, reasoning, created_at) VALUES ('f1', ?, 'NVDA', 'buy', 2, 100, 1, 'demo', 'you', 'r', 5)").run(spaceId);
  db.query("INSERT INTO paper_fills (id, space_id, symbol, side, qty, price, quote_at, source, actor, reasoning, created_at) VALUES ('f2', ?, 'TSLA', 'buy', 2, 100, 1, 'demo', 'you', 'r', 5)").run(spaceId);
  db.query("INSERT INTO paper_fills (id, space_id, symbol, side, qty, price, quote_at, source, actor, reasoning, created_at) VALUES ('f3', ?, 'TSLA', 'sell', 2, 100, 1, 'demo', 'you', 'r', 6)").run(spaceId);
  db.query("INSERT INTO market_strategies (id, space_id, name, rules, symbols, cadence, max_position_value, max_trades_per_day, status, created_at, updated_at) VALUES ('st', ?, 'n', 'r', '[\"AMD\",\"AAPL\"]', 'open', 1000, 3, 'active', 1, 1)").run(spaceId);
  expect(trackedInstruments(db).map(instrumentKey)).toEqual(["NVDA", "SHOP.TO", "AMD", "AAPL", "MSFT"]);
});

test("streamed symbols with no tick for 5 minutes are polled, and a silent stream reconnects", async () => {
  watch("AAPL");
  watch("MSFT");
  const s = setup("2026-11-05T15:00:00Z");
  await s.feed.start();
  await s.feed.setViewers(1);
  expect(s.streams).toHaveLength(1);
  const before = s.quoteCalls.length;
  now += 2 * 60_000;
  s.streams[0]!.ev.quote({ key: "AAPL", price: 1, prevClose: 1, at: now, source: "alpaca", freshness: "live" });
  now += POLL_MS + 60_000;
  s.timers.fireAll();
  await s.feed.idle();
  // AAPL ticked 4 minutes ago; MSFT never did.
  expect(s.quoteCalls.slice(before).map((l) => l.map(instrumentKey))).toEqual([["MSFT"]]);
  expect(s.streams).toHaveLength(1);
  now += POLL_MS;
  s.timers.fireAll();
  await s.feed.idle();
  // Quiet symbols are polled, but the stream is only presumed dead after 15 minutes without any trade.
  expect(s.streams).toHaveLength(1);
  now += 3 * POLL_MS;
  s.timers.fireAll();
  await s.feed.idle();
  expect(s.streams[0]!.closed).toBe(true);
  expect(s.streams).toHaveLength(2);
  s.feed.stop();
});

test("no Keychain reads while the market is closed and nobody is looking", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-feedkc-"));
  process.env.FAKE_SECURITY_STORE = join(dir, "store.json");
  process.env.FAKE_SECURITY_ARGV = join(dir, "argv.log");
  try {
    watch("AAPL");
    now = Date.parse("2026-11-07T17:00:00Z");
    const timers = fakeTimers();
    const data = createMarketData({ db, keychain: createKeychain(FAKE_SECURITY), now: () => now });
    const feed = createFeed({ db, data, onQuotes: () => {}, strategyActive: () => false, now: () => now, timers });
    await feed.start();
    for (let i = 0; i < 8; i++) {
      now += OFF_RECHECK_MS;
      timers.fireAll();
      await feed.idle();
    }
    await feed.reevaluate();
    expect(existsSync(join(dir, "argv.log"))).toBe(false);
    // In session, the feed reads the Keychain before fetching, then not again for 10 minutes.
    now = Date.parse("2026-11-09T15:00:00Z");
    timers.fireAll();
    await feed.idle();
    const first = readFileSync(join(dir, "argv.log"), "utf8").trim().split("\n").length;
    expect(first).toBe(5); // one read per key account, Tiingo included
    now += POLL_MS;
    timers.fireAll();
    await feed.idle();
    expect(readFileSync(join(dir, "argv.log"), "utf8").trim().split("\n").length).toBe(first);
    feed.stop();
  } finally {
    delete process.env.FAKE_SECURITY_STORE;
    delete process.env.FAKE_SECURITY_ARGV;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("paper and strategy symbols are tracked only with Advanced on", () => {
  setAdvanced(db, spaceId, false);
  watch("AMZN");
  db.query("INSERT INTO paper_fills (id, space_id, symbol, side, qty, price, quote_at, source, actor, reasoning, created_at) VALUES ('f1', ?, 'NVDA', 'buy', 2, 100, 1, 'demo', 'you', 'r', 5)").run(spaceId);
  db.query("INSERT INTO market_strategies (id, space_id, name, rules, symbols, cadence, max_position_value, max_trades_per_day, status, created_at, updated_at) VALUES ('st', ?, 'n', 'r', '[\"AMD\"]', 'open', 1000, 3, 'active', 1, 1)").run(spaceId);
  expect(trackedInstruments(db).map(instrumentKey)).toEqual(["AMZN"]);
  setAdvanced(db, spaceId, true);
  expect(trackedInstruments(db).map(instrumentKey)).toEqual(["NVDA", "AMD", "AMZN"]);
});

test("no daily 6M prefetch while Advanced is off", async () => {
  setAdvanced(db, spaceId, false);
  watch("AAPL");
  const s = setup("2026-11-05T15:00:00Z");
  await s.feed.start();
  expect(s.barCalls).toEqual([]);
  s.feed.stop();
});
