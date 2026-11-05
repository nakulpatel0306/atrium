import { beforeEach, expect, test } from "bun:test";
import { alpacaProvider } from "../../../src/engine/markets/providers/alpaca";
import { ProviderError, type Quote } from "../../../src/engine/markets/providers/types";
import { fakeTimers, FakeWebSocket, fixture, jsonResponse, stubFetch } from "./fakes";

const CREDS = { keyId: "PKCANARY12345", secret: "SKCANARY67890" };
const NOW = Date.parse("2026-11-05T16:05:00Z");
const AAPL = { symbol: "AAPL", exchange: "US" as const };
const MSFT = { symbol: "MSFT", exchange: "US" as const };
const WS = FakeWebSocket as unknown as typeof WebSocket;

beforeEach(() => {
  FakeWebSocket.instances = [];
});

test("quotes maps snapshots", async () => {
  const f = stubFetch(() => jsonResponse(fixture("alpaca-snapshots.json")));
  const p = alpacaProvider(CREDS, { fetch: f.fetch, now: () => NOW });
  const q = await p.quotes([AAPL, MSFT]);
  expect(q).toEqual([
    { key: "AAPL", price: 231.5, prevClose: 229.4, at: Date.parse("2026-11-05T16:02:11.123Z"), source: "alpaca", freshness: "live" },
    { key: "MSFT", price: 412.25, prevClose: 411, at: Date.parse("2026-11-05T16:01:59.9Z"), source: "alpaca", freshness: "live" },
  ]);
  const { url, headers } = f.calls[0]!;
  expect(url.pathname).toBe("/v2/stocks/snapshots");
  expect(url.searchParams.get("feed")).toBe("iex");
  expect(url.searchParams.get("symbols")).toBe("AAPL,MSFT");
  expect(headers["apca-api-key-id"]).toBe(CREDS.keyId);
  expect(headers["apca-api-secret-key"]).toBe(CREDS.secret);
  expect(p.covers({ symbol: "SHOP", exchange: "TSX" })).toBe(false);
  expect(p.covers({ symbol: "AAPL", exchange: "NEO" })).toBe(false);
  expect(p.maxStreamSymbols).toBe(30);
});

test("quotes are batched 100 symbols per request", async () => {
  const f = stubFetch(() => jsonResponse({}));
  const list = Array.from({ length: 150 }, (_, i) => ({ symbol: `S${i}`, exchange: "US" as const }));
  await alpacaProvider(CREDS, { fetch: f.fetch, now: () => NOW }).quotes(list);
  expect(f.calls.map((c) => c.url.searchParams.get("symbols")!.split(",").length)).toEqual([100, 50]);
});

test("bars follows next_page_token", async () => {
  const f = stubFetch((url) => jsonResponse(fixture(url.searchParams.get("page_token") ? "alpaca-bars-page2.json" : "alpaca-bars-1day.json")));
  const p = alpacaProvider(CREDS, { fetch: f.fetch, now: () => NOW });
  const bars = await p.bars(AAPL, "1Day", Date.parse("2026-11-01T00:00:00Z"), NOW);
  expect(bars.map((b) => b.t)).toEqual([
    Date.parse("2026-11-02T05:00:00Z") / 1000,
    Date.parse("2026-11-03T05:00:00Z") / 1000,
    Date.parse("2026-11-04T05:00:00Z") / 1000,
  ]);
  expect(bars[0]).toEqual({ t: Date.parse("2026-11-02T05:00:00Z") / 1000, o: 225, h: 227, l: 224, c: 226.5, v: 450000 });
  expect(f.calls).toHaveLength(2);
  expect(f.calls[1]!.url.searchParams.get("page_token")).toBe("QUFQTHxEfDIwMjYtMTEtMDNUMDU6MDA6MDBa");
  const first = f.calls[0]!.url.searchParams;
  expect(first.get("feed")).toBe("sip");
  expect(first.get("timeframe")).toBe("1Day");
  expect(first.get("adjustment")).toBe("split");
  expect(Date.parse(first.get("end")!)).toBeLessThanOrEqual(NOW - 16 * 60_000);
  const g = stubFetch(() => jsonResponse({ bars: { AAPL: [] }, next_page_token: null }));
  await alpacaProvider(CREDS, { fetch: g.fetch, now: () => NOW }).bars(AAPL, "5Min", NOW - 86_400_000, NOW);
  expect(g.calls[0]!.url.searchParams.get("feed")).toBe("iex");
  expect(g.calls[0]!.url.searchParams.get("timeframe")).toBe("5Min");
});

const failure = async (p: Promise<unknown>) => {
  const e = (await p.catch((x) => x)) as ProviderError;
  expect(e).toBeInstanceOf(ProviderError);
  expect(e.message).not.toContain(CREDS.secret);
  expect(e.message).not.toContain(CREDS.keyId);
  return e;
};

test("errors map to plain, secret-free provider errors", async () => {
  const echo = `bad creds ${CREDS.keyId} ${CREDS.secret}`;
  for (const status of [401, 403]) {
    const f = stubFetch(() => new Response(echo, { status }));
    const e = await failure(alpacaProvider(CREDS, { fetch: f.fetch, now: () => NOW }).quotes([AAPL]));
    expect(e.kind).toBe("auth");
    expect(e.message).toBe("Alpaca rejected the key. Check the key ID and secret in Settings → Market data.");
  }
  const r = stubFetch(() => new Response(echo, { status: 429 }));
  const e429 = await failure(alpacaProvider(CREDS, { fetch: r.fetch, now: () => NOW }).quotes([AAPL]));
  expect(e429.kind).toBe("rate_limited");
  expect(e429.retryAfter).toBe(NOW + 60_000);
  const down = (async () => {
    throw new Error(`connect ECONNREFUSED https://data.alpaca.markets?key=${CREDS.keyId}&secret=${CREDS.secret}`);
  }) as unknown as typeof fetch;
  const eNet = await failure(alpacaProvider(CREDS, { fetch: down, now: () => NOW }).quotes([AAPL]));
  expect(eNet.kind).toBe("unavailable");
  const e500 = await failure(alpacaProvider(CREDS, { fetch: stubFetch(() => new Response(echo, { status: 500 })).fetch, now: () => NOW }).bars(AAPL, "1Day", 0, NOW));
  expect(e500.kind).toBe("unavailable");
});

test("only data hosts", async () => {
  const f = stubFetch((url) => jsonResponse(url.pathname.includes("news") ? fixture("alpaca-news.json") : url.pathname.includes("bars") ? fixture("alpaca-bars-page2.json") : fixture("alpaca-snapshots.json")));
  const p = alpacaProvider(CREDS, { fetch: f.fetch, WebSocket: WS, now: () => NOW });
  await p.quotes([AAPL]);
  await p.bars(AAPL, "1Day", 0, NOW);
  await p.news!([AAPL], NOW - 86_400_000);
  await p.validate();
  p.stream!([AAPL], { quote: () => {}, status: () => {} }).close();
  const hosts = new Set([...f.calls.map((c) => c.url.host), ...FakeWebSocket.instances.map((w) => new URL(w.url).host)]);
  for (const h of hosts) expect(["data.alpaca.markets", "stream.data.alpaca.markets"]).toContain(h);
  expect(FakeWebSocket.instances[0]!.url).toBe("wss://stream.data.alpaca.markets/v2/iex");
});

test("stream authenticates, subscribes and maps trades", async () => {
  const f = stubFetch(() => jsonResponse(fixture("alpaca-snapshots.json")));
  const timers = fakeTimers();
  const p = alpacaProvider(CREDS, { fetch: f.fetch, WebSocket: WS, now: () => NOW, timers });
  await p.quotes([AAPL]);
  const quotes: Quote[] = [];
  const statuses: { ok: boolean; message: string }[] = [];
  const s = p.stream!([AAPL, MSFT], { quote: (q) => quotes.push(q), status: (x) => statuses.push(x) });
  const ws = FakeWebSocket.instances[0]!;
  ws.open();
  ws.receive([{ T: "success", msg: "connected" }]);
  expect(ws.sent[0]).toEqual({ action: "auth", key: CREDS.keyId, secret: CREDS.secret });
  ws.receive([{ T: "success", msg: "authenticated" }]);
  expect(ws.sent[1]).toEqual({ action: "subscribe", trades: ["AAPL", "MSFT"] });
  expect(statuses.at(-1)!.ok).toBe(true);
  ws.receive([{ T: "t", S: "AAPL", p: 231.75, t: "2026-11-05T16:06:00.5Z", s: 10, x: "V" }, { T: "t", S: "ZZZ", p: 1, t: "2026-11-05T16:06:00Z" }]);
  expect(quotes[0]).toEqual({ key: "AAPL", price: 231.75, prevClose: 229.4, at: Date.parse("2026-11-05T16:06:00.5Z"), source: "alpaca", freshness: "live" });
  ws.receive([{ T: "t", S: "MSFT", p: 413, t: "2026-11-05T16:06:01Z" }]);
  expect(quotes.find((q) => q.key === "MSFT")!.prevClose).toBeNull();
  s.set([MSFT, { symbol: "NVDA", exchange: "US" }]);
  expect(ws.sent).toContainEqual({ action: "unsubscribe", trades: ["AAPL"] });
  expect(ws.sent).toContainEqual({ action: "subscribe", trades: ["NVDA"] });
  s.close();
  expect(ws.closed).toBe(true);
  ws.drop();
  expect(timers.pending.size).toBe(0);
  expect(FakeWebSocket.instances).toHaveLength(1);
});

test("stream errors report plainly", () => {
  const statuses: { ok: boolean; message: string }[] = [];
  const p = alpacaProvider(CREDS, { WebSocket: WS, now: () => NOW, timers: fakeTimers() });
  p.stream!([AAPL], { quote: () => {}, status: (x) => statuses.push(x) });
  const ws = FakeWebSocket.instances[0]!;
  ws.receive([{ T: "error", code: 406, msg: "connection limit exceeded" }]);
  expect(statuses.at(-1)).toEqual({
    ok: false,
    message: "Alpaca allows one live connection on the free plan, and another app is using it. Checking every 3 minutes instead.",
  });
  p.stream!([AAPL], { quote: () => {}, status: (x) => statuses.push(x) });
  FakeWebSocket.instances[1]!.receive([{ T: "error", code: 402, msg: "auth failed" }]);
  expect(statuses.at(-1)).toEqual({ ok: false, message: "Alpaca rejected the key. Check the key ID and secret in Settings → Market data." });
});

test("unexpected closes reconnect after 5s, 30s, then 120s", () => {
  const timers = fakeTimers();
  const p = alpacaProvider(CREDS, { WebSocket: WS, now: () => NOW, timers });
  p.stream!([AAPL], { quote: () => {}, status: () => {} });
  for (let i = 0; i < 4; i++) {
    FakeWebSocket.instances.at(-1)!.drop();
    timers.fireAll();
  }
  expect(timers.delays).toEqual([5_000, 30_000, 120_000, 120_000]);
  expect(FakeWebSocket.instances).toHaveLength(5);
});

test("news maps per symbol", async () => {
  const f = stubFetch(() => jsonResponse(fixture("alpaca-news.json")));
  const items = await alpacaProvider(CREDS, { fetch: f.fetch, now: () => NOW }).news!([AAPL, MSFT], NOW - 86_400_000);
  expect(items).toEqual([
    { key: "AAPL", headline: "Apple supplier lifts guidance on strong handset demand", source: "benzinga", url: "https://www.benzinga.com/news/26/11/41234567/apple-supplier", at: Date.parse("2026-11-05T13:10:00Z") },
    { key: "MSFT", headline: "Microsoft cloud deal announced", source: "benzinga", url: "https://www.benzinga.com/news/26/11/41234568/microsoft-cloud", at: Date.parse("2026-11-05T12:00:00Z") },
  ]);
  expect(f.calls[0]!.url.pathname).toBe("/v1beta1/news");
  expect(f.calls[0]!.url.searchParams.get("symbols")).toBe("AAPL,MSFT");
});
