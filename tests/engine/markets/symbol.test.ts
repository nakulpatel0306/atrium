import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../../src/engine/db";
import { createAlert } from "../../../src/engine/markets/alerts";
import { saveEarnings, saveNews } from "../../../src/engine/markets/events";
import { instrumentKey, type Instrument } from "../../../src/engine/markets/instrument";
import { createList } from "../../../src/engine/markets/lists";
import { ProviderError, type MarketProvider, type Quote } from "../../../src/engine/markets/providers/types";
import { saveNotes } from "../../../src/engine/markets/research";
import { refreshSymbol, REFRESH_EVERY_MS, symbolView } from "../../../src/engine/markets/symbol";
import { saveQuotes } from "../../../src/engine/markets/cache";
import { tempHome } from "../../helpers";
import { NOW, simpleFixture, viewData } from "./simple-fixture";

let home: ReturnType<typeof tempHome>;
let db: Database;
let fx: ReturnType<typeof simpleFixture>;
beforeEach(() => {
  home = tempHome();
  db = openDb();
  fx = simpleFixture(db);
});
afterEach(() => {
  db.close();
  home.cleanup();
});

const DAY = 86_400_000;

// A Finnhub-shaped research provider and a quotes function that record every call.
function rig(opts: { fail?: ProviderError } = {}) {
  const calls: string[] = [];
  const research = {
    id: "finnhub",
    async profile(i: Instrument) {
      calls.push(`profile ${i.symbol}`);
      if (opts.fail) throw opts.fail;
      return { name: "NVIDIA Corp", country: "US", currency: "USD", industry: "Semiconductors", exchange: "NASDAQ NMS - GLOBAL MARKET" };
    },
    async metric(i: Instrument) {
      calls.push(`metric ${i.symbol}`);
      if (opts.fail) throw opts.fail;
      return { pe: 55.2, high52: 212.5, low52: 86.6, divYield: 0.02, marketCap: 4_620_000 };
    },
    async news(list: Instrument[]) {
      calls.push(`news ${list.map((i) => i.symbol).join(",")}`);
      if (opts.fail) throw opts.fail;
      return [{ key: "NVDA", headline: "Nvidia ships a new chip", source: "Reuters", url: "https://example.com/nvda", at: NOW - 3600_000 }];
    },
    async earnings(list: Instrument[]) {
      calls.push(`earnings ${list.map((i) => i.symbol).join(",")}`);
      if (opts.fail) throw opts.fail;
      return [{ key: "NVDA", date: "2026-11-19", hour: "amc", epsEstimate: 1.1 }];
    },
  } as unknown as MarketProvider;
  const data = viewData({
    async quotes(list: Instrument[]) {
      calls.push(`quotes ${list.map(instrumentKey).join(",")}`);
      if (opts.fail) return { quotes: [], missing: list.map((i) => ({ key: instrumentKey(i), reason: "Finnhub's limit is reached." })) };
      const quotes = list.map((i): Quote => ({ key: instrumentKey(i), price: 190, prevClose: 185, at: NOW, source: "finnhub", freshness: "live" }));
      saveQuotes(db, quotes);
      return { quotes, missing: [] };
    },
    research: () => research,
  });
  return { data, calls };
}

test("a held US stock shows price, stats with sources, position, next earnings and news", async () => {
  const { data } = rig();
  db.query("INSERT INTO instrument_meta (key, name, kind, pe, high52, low52, div_yield, market_cap, metrics_at, listing) VALUES ('AMZN', 'Amazon.com Inc', 'stock', 40.1, 260, 160, NULL, 2410000, ?, 'NASDAQ NMS - GLOBAL MARKET')").run(NOW - DAY);
  saveEarnings(db, [{ key: "AMZN", date: "2026-11-12", hour: "amc", epsEstimate: 1.23 }], "finnhub");
  saveNews(db, Array.from({ length: 7 }, (_, n) => ({ key: "AMZN", headline: `Story ${n}`, source: "CNBC", url: `https://example.com/${n}`, at: NOW - n * 3600_000 })), NOW);
  saveNotes(db, fx.spaceId, "AMZN", { notes: "Cloud margins.", thesis: "Not shown here." });
  createAlert(db, { spaceId: fx.spaceId, key: "AMZN", rule: { kind: "price_above", level: 300 } });
  const v = symbolView(db, data, fx.spaceId, "AMZN", NOW);
  expect(v).toMatchObject({ key: "AMZN", symbol: "AMZN", exchange: "US", tv: "NASDAQ:AMZN", chart: { ok: true }, notes: "Cloud margins." });
  expect(v.price!.value).toBe(250);
  expect(v.price!.source).toBe("Finnhub · real-time");
  expect(v.dayPct).toBeCloseTo(2.04, 1);
  expect(v.stats.map((s) => s.label)).toEqual(["Market cap", "P/E", "52-week range"]);
  expect(v.stats[0]).toEqual({ label: "Market cap", value: "US$2.41T", source: expect.stringMatching(/^Finnhub · metrics [A-Z][a-z]{2} \d{1,2}$/) });
  expect(v.stats[2]!.value).toBe("US$160.00 – US$260.00");
  expect(v.position).toMatchObject({ quantity: 10, accounts: ["TFSA"] });
  expect(v.position!.gainCad).not.toBeNull();
  expect(v.earnings).toMatchObject({ date: "2026-11-12", hour: "amc" });
  expect(v.news.map((n) => n.headline)).toEqual(["Story 0", "Story 1", "Story 2", "Story 3", "Story 4"]);
  expect(v.lists).toEqual([{ id: fx.holdingsList, name: "Holdings", has: true }]);
  expect(v.alerts).toHaveLength(1);
  expect(v.asks).toEqual([]);
});

test("an untracked symbol works", async () => {
  const { data, calls } = rig();
  createList(db, fx.spaceId, "Ideas");
  const before = symbolView(db, data, fx.spaceId, "NVDA", NOW);
  expect(before).toMatchObject({ key: "NVDA", price: null, position: null, tv: "NVDA", refreshedAt: null });
  expect(before.lists.map((l) => l.has)).toEqual([false, false]);
  expect(await refreshSymbol(db, data, "NVDA", NOW)).toEqual({ refreshed: true, note: null });
  // TradingView's widgets show fundamentals and news, so the refresh asks Finnhub only for what Atrium computes with.
  expect(calls).toEqual(["quotes NVDA", "profile NVDA", "earnings NVDA"]);
  const after = symbolView(db, data, fx.spaceId, "NVDA", NOW);
  expect(after.price!.value).toBe(190);
  expect(after.tv).toBe("NASDAQ:NVDA");
  expect(after.name).toBe("NVIDIA Corp");
  expect(after.stats).toEqual([]);
  expect(after.earnings?.date).toBe("2026-11-19");
  expect(after.news).toEqual([]);
  expect(after.refreshedAt).toBe(NOW);
});

test("refresh is throttled to once per 10 minutes per key", async () => {
  const { data, calls } = rig();
  await refreshSymbol(db, data, "NVDA", NOW);
  const n = calls.length;
  expect(await refreshSymbol(db, data, "NVDA", NOW + 5 * 60_000)).toEqual({ refreshed: false, note: null });
  expect(calls).toHaveLength(n);
  expect(REFRESH_EVERY_MS).toBe(600_000);
  expect((await refreshSymbol(db, data, "NVDA", NOW + 11 * 60_000)).refreshed).toBe(true);
  expect(calls.length).toBeGreaterThan(n);
});

test("a TSX key makes no network call and says when prices update", async () => {
  const { data, calls } = rig();
  expect(await refreshSymbol(db, data, "XEQT.TO", NOW)).toEqual({ refreshed: false, note: "Canadian prices update after the close from Alpha Vantage." });
  expect(calls).toEqual([]);
  expect(symbolView(db, data, fx.spaceId, "XEQT.TO", NOW)).toMatchObject({ tv: "TSX:XEQT", kind: "etf" });
  expect(symbolView(db, data, fx.spaceId, "AMZN", NOW).kind).toBe("stock");
});

test("CBOE:MARS gets TradingView's chart (it renders in the free widget)", () => {
  const v = symbolView(db, rig().data, fx.spaceId, "MARS", NOW);
  expect(v.tv).toBe("CBOE:MARS");
  expect(v.chart).toEqual({ ok: true });
});

test("a provider failure becomes one plain note and no throw", async () => {
  const { data } = rig({ fail: new ProviderError("rate_limited", "Finnhub's limit is reached.") });
  const r = await refreshSymbol(db, data, "NVDA", NOW);
  expect(r.refreshed).toBe(true);
  expect(r.note).toContain("Finnhub is busy");
  expect(r.note!.match(/Finnhub is busy/g)).toHaveLength(1);
});

test("requestAsk queues a Claude task with the question", async () => {
  const { requestAsk } = await import("../../../src/engine/markets/symbol");
  const t = requestAsk(db, fx.spaceId, "AMZN", "  Why up today?  ");
  expect(t).toMatchObject({ agent: "claude", purpose: "ask", subject: "AMZN", weight: "light", allowOnBattery: true, title: "Ask Claude about AMZN", detail: "Why up today?" });
  const v = symbolView(db, rig().data, fx.spaceId, "AMZN", NOW);
  expect(v.asks).toMatchObject([{ status: "queued", question: "Why up today?", taskId: t.id }]);
});

test("a second ask while one is open is refused", async () => {
  const { requestAsk } = await import("../../../src/engine/markets/symbol");
  requestAsk(db, fx.spaceId, "AMZN", "");
  expect(() => requestAsk(db, fx.spaceId, "AMZN", "again")).toThrow("Claude is already looking at AMZN.");
});

test("a 501-character question is refused", async () => {
  const { requestAsk, ASK_MAX_CHARS } = await import("../../../src/engine/markets/symbol");
  expect(ASK_MAX_CHARS).toBe(500);
  expect(() => requestAsk(db, fx.spaceId, "AMZN", "x".repeat(501))).toThrow("Keep the question under 500 characters.");
});
