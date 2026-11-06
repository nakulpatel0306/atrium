import { beforeEach, expect, test } from "bun:test";
import { finnhubProvider } from "../../../src/engine/markets/providers/finnhub";
import { ProviderError, type Quote } from "../../../src/engine/markets/providers/types";
import { fakeTimers, FakeWebSocket, fixture, jsonResponse, stubFetch } from "./fakes";

const TOKEN = "CANARYtok123";
const NOW = Date.parse("2026-11-05T16:05:00Z");
const AAPL = { symbol: "AAPL", exchange: "US" as const };
const WS = FakeWebSocket as unknown as typeof WebSocket;

beforeEach(() => {
  FakeWebSocket.instances = [];
});

test("quote maps c/pc/t", async () => {
  const f = stubFetch(() => jsonResponse(fixture("finnhub-quote.json")));
  const p = finnhubProvider(TOKEN, { fetch: f.fetch, now: () => NOW });
  expect(await p.quotes([AAPL])).toEqual([{ key: "AAPL", price: 231.5, prevClose: 229.4, at: 1793894531000, source: "finnhub", freshness: "live" }]);
  expect(f.calls[0]!.url.host).toBe("finnhub.io");
  expect(f.calls[0]!.url.pathname).toBe("/api/v1/quote");
  expect(f.calls[0]!.url.searchParams.get("symbol")).toBe("AAPL");
  expect(p.covers({ symbol: "SHOP", exchange: "TSX" })).toBe(false);
  expect(p.maxStreamSymbols).toBe(50);
});

const err = async (p: Promise<unknown>) => {
  const e = (await p.catch((x) => x)) as ProviderError;
  expect(e).toBeInstanceOf(ProviderError);
  expect(e.message).not.toContain(TOKEN);
  return e;
};

test("errors", async () => {
  const zero = stubFetch(() => jsonResponse({ c: 0, d: null, dp: null, h: 0, l: 0, o: 0, pc: 0, t: 0 }));
  expect((await err(finnhubProvider(TOKEN, { fetch: zero.fetch, now: () => NOW }).quotes([AAPL]))).kind).toBe("unknown_symbol");
  const auth = stubFetch(() => new Response(`{"error":"Invalid API key ${TOKEN}"}`, { status: 401 }));
  expect((await err(finnhubProvider(TOKEN, { fetch: auth.fetch, now: () => NOW }).quotes([AAPL]))).kind).toBe("auth");
  const down = (async (u: string) => {
    throw new Error(`fetch failed: ${u}`);
  }) as unknown as typeof fetch;
  const e = await err(finnhubProvider(TOKEN, { fetch: down, now: () => NOW }).quotes([AAPL]));
  expect(e.kind).toBe("unavailable");
  const b = await err(finnhubProvider(TOKEN, { now: () => NOW }).bars(AAPL, "1Day", 0, NOW));
  expect(b.kind).toBe("no_history");
  expect(b.message).toBe("Finnhub's free plan has no price history. Switch to Alpaca in Settings → Market data for charts.");
});

test("stream subscribes and maps trades", () => {
  const timers = fakeTimers();
  const p = finnhubProvider(TOKEN, { WebSocket: WS, now: () => NOW, timers });
  const quotes: Quote[] = [];
  const s = p.stream!([AAPL], { quote: (q) => quotes.push(q), status: () => {} });
  const ws = FakeWebSocket.instances[0]!;
  expect(new URL(ws.url).host).toBe("ws.finnhub.io");
  ws.open();
  expect(ws.sent).toEqual([{ type: "subscribe", symbol: "AAPL" }]);
  ws.receive({ type: "trade", data: [{ s: "AAPL", p: 232.1, t: 1793894600123, v: 5 }] });
  expect(quotes).toEqual([{ key: "AAPL", price: 232.1, prevClose: null, at: 1793894600123, source: "finnhub", freshness: "live" }]);
  s.set([{ symbol: "MSFT", exchange: "US" }]);
  expect(ws.sent).toContainEqual({ type: "unsubscribe", symbol: "AAPL" });
  expect(ws.sent).toContainEqual({ type: "subscribe", symbol: "MSFT" });
  s.close();
  expect(ws.closed).toBe(true);
});

test("news maps datetime seconds", async () => {
  const f = stubFetch(() => jsonResponse(fixture("finnhub-news.json")));
  const items = await finnhubProvider(TOKEN, { fetch: f.fetch, now: () => NOW }).news!([AAPL], NOW - 86_400_000);
  expect(items).toEqual([{ key: "AAPL", headline: "Apple supplier lifts guidance on strong handset demand", source: "MarketWatch", url: "https://finnhub.io/api/news?id=abc", at: 1793884200000 }]);
  expect(f.calls[0]!.url.pathname).toBe("/api/v1/company-news");
  expect(f.calls[0]!.url.searchParams.get("from")).toBe("2026-11-04");
  expect(f.calls[0]!.url.searchParams.get("to")).toBe("2026-11-05");
});

test("an auth error on the stream stops retrying", () => {
  const timers = fakeTimers();
  const statuses: { ok: boolean; message: string }[] = [];
  const p = finnhubProvider(TOKEN, { WebSocket: WS, now: () => NOW, timers });
  p.stream!([AAPL], { quote: () => {}, status: (s) => statuses.push(s) });
  const ws = FakeWebSocket.instances[0]!;
  ws.receive({ type: "error", msg: "Invalid API key" });
  expect(statuses.at(-1)).toEqual({ ok: false, message: "Finnhub rejected the token. Check it in Settings → Market data." });
  expect(ws.closed).toBe(true);
  ws.drop();
  expect(timers.pending.size).toBe(0);
});

test("metric, profile and earnings map Finnhub's fields", async () => {
  const s = stubFetch((url) =>
    jsonResponse(fixture(url.pathname.endsWith("/stock/metric") ? "investing/finnhub-metric.json" : url.pathname.endsWith("/stock/profile2") ? "investing/finnhub-profile2.json" : "investing/finnhub-earnings.json")),
  );
  const p = finnhubProvider(TOKEN, { fetch: s.fetch, now: () => NOW });
  const NOWI = { symbol: "NOW", exchange: "US" as const };
  expect(await p.metric!(NOWI)).toEqual({ pe: 61.84, high52: 1198.09, low52: 712.5, divYield: null });
  expect(s.calls[0]!.url.searchParams.get("metric")).toBe("all");
  expect(await p.profile!(NOWI)).toEqual({ name: "ServiceNow Inc", country: "US", currency: "USD", industry: "Technology" });
  const e = await p.earnings!([{ symbol: "RKLB", exchange: "US" }], "2026-11-05", "2026-12-05");
  expect(e).toEqual([
    { key: "RKLB", date: "2026-11-10", hour: "amc", epsEstimate: 1.23 },
    { key: "RKLB", date: "2026-11-20", hour: null, epsEstimate: null },
  ]);
  const cal = s.calls.at(-1)!.url;
  expect([cal.pathname, cal.searchParams.get("from"), cal.searchParams.get("to"), cal.searchParams.get("symbol")]).toEqual(["/api/v1/calendar/earnings", "2026-11-05", "2026-12-05", "RKLB"]);
  const empty = finnhubProvider(TOKEN, { fetch: stubFetch(() => jsonResponse({})).fetch, now: () => NOW });
  expect(await empty.profile!(NOWI)).toBeNull();
});
