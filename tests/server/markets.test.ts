import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDb } from "../../src/engine/db";
import { config } from "../../src/engine/config";
import { createSpace } from "../../src/engine/spaces";
import { setSetting } from "../../src/engine/settings";
import { createMarketData } from "../../src/engine/markets/data";
import { createFeed } from "../../src/engine/markets/feed";
import { createKeychain } from "../../src/engine/markets/keychain";
import { demoProvider } from "../../src/engine/markets/providers/demo";
import { startServer } from "../../src/server/server";
import { tempHome } from "../helpers";

const FAKE = resolve(import.meta.dir, "../fixtures/fake-security.ts");
const FIXTURES = resolve(import.meta.dir, "../fixtures/markets");
const IN_SESSION = Date.parse("2026-11-05T15:00:00Z");
const CLOSED = Date.parse("2026-11-07T15:00:00Z");

let home: ReturnType<typeof tempHome>;
let keyDir: string;
let db: Database;
let server: ReturnType<typeof startServer>;
let base: string;
let now: number;

function boot(opts: { demo?: boolean; fetch?: typeof fetch } = {}) {
  if (opts.demo !== false) setSetting(db, "markets.provider", "demo");
  const keychain = createKeychain(FAKE);
  const clock = () => now;
  const data = createMarketData({ db, keychain, now: clock, fetch: opts.fetch, providers: opts.demo === false ? {} : { demo: demoProvider({ now: clock }) } });
  const feed = createFeed({ db, data, onQuotes: () => {}, strategyActive: () => false, now: clock });
  server = startServer({ db, runner: { kick: () => {} }, setup: async () => { throw new Error("no"); }, port: 0, markets: { data, feed, keychain, kick: () => {}, now: clock, fetch: opts.fetch } });
  base = `http://127.0.0.1:${server.port}`;
  return { keychain, data };
}

beforeEach(() => {
  home = tempHome();
  keyDir = mkdtempSync(join(tmpdir(), "atrium-keys-"));
  process.env.FAKE_SECURITY_STORE = join(keyDir, "store.json");
  db = openDb();
  now = IN_SESSION;
});
afterEach(() => {
  server?.stop(true);
  db.close();
  delete process.env.FAKE_SECURITY_STORE;
  rmSync(keyDir, { recursive: true, force: true });
  home.cleanup();
});

const call = (method: string, path: string, body?: unknown) =>
  fetch(base + path, { method, headers: { origin: base, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const get = (path: string) => fetch(base + path);
const markets = () => createSpace(db, { name: "Stocks", kind: "markets", goal: "watch" });

test("watchlist, holdings and alerts round-trip; the view has demo quotes", async () => {
  boot();
  const s = markets();
  expect((await call("POST", `/api/markets/${s.id}/watchlist`, { key: "aapl" })).status).toBe(200);
  expect((await call("POST", `/api/markets/${s.id}/watchlist`, { key: "not a symbol" })).status).toBe(400);
  expect(await (await call("POST", `/api/markets/${s.id}/watchlist`, { key: "" })).json()).toEqual({ error: "Type a symbol like AAPL or SHOP.TO." });
  const h = await (await call("POST", `/api/markets/${s.id}/holdings`, { account: "TFSA", key: "SHOP.TO", quantity: 3, bookValue: 400, currency: "CAD" })).json();
  expect(h.key).toBe("SHOP.TO");
  expect((await call("PATCH", `/api/markets/${s.id}/holdings/${h.id}`, { quantity: 4 })).status).toBe(200);
  const alert = await (await call("POST", `/api/markets/${s.id}/alerts`, { key: "AAPL", rule: { kind: "price_above", level: 1000 } })).json();
  expect(alert.status).toBe("armed");
  expect((await call("POST", `/api/markets/${s.id}/alerts`, { key: "AAPL", rule: { kind: "price_above", level: -1 } })).status).toBe(400);
  expect((await call("PATCH", `/api/markets/${s.id}/alerts/${alert.id}`, { status: "off" })).status).toBe(200);
  const view = await (await get(`/api/markets/${s.id}`)).json();
  expect(view.watchlist[0].key).toBe("AAPL");
  expect(view.watchlist[0].quote.freshness).toBe("demo");
  expect(view.holdings[0]).toMatchObject({ key: "SHOP.TO", quantity: 4 });
  expect(view.holdings[0].quote.freshness).toBe("demo");
  expect(view.alerts[0].status).toBe("off");
  expect(view.paper.cash).toBe(10_000);
  expect(view.feed.mode).toBeDefined();
  expect(view.data.usProvider).toBe("demo");
  expect((await call("DELETE", `/api/markets/${s.id}/watchlist/AAPL`)).status).toBe(200);
  expect((await call("DELETE", `/api/markets/${s.id}/holdings/${h.id}`)).status).toBe(200);
  expect((await call("DELETE", `/api/markets/${s.id}/alerts/${alert.id}`)).status).toBe(200);
  const after = await (await get(`/api/markets/${s.id}`)).json();
  expect([after.watchlist.length, after.holdings.length, after.alerts.length]).toEqual([0, 0, 0]);
});

test("a non-markets space is 404", async () => {
  boot();
  const g = createSpace(db, { name: "G", kind: "general", goal: "" });
  const r = await get(`/api/markets/${g.id}`);
  expect(r.status).toBe(404);
  expect(await r.json()).toEqual({ error: "No such markets space." });
});

test("import preview then commit; the commit re-parses the csv", async () => {
  boot();
  const s = markets();
  const csv = readFileSync(join(FIXTURES, "ws-holdings.csv"), "utf8");
  const preview = await (await call("POST", `/api/markets/${s.id}/import/preview`, { csv })).json();
  expect(preview.format).toBe("wealthsimple_holdings");
  expect(preview.rows).toHaveLength(4);
  const tampered = { csv, rows: [{ account: "X", symbol: "EVIL", exchange: "US", name: "", quantity: 1e9, bookValue: null, currency: "USD" }] };
  const done = await (await call("POST", `/api/markets/${s.id}/import`, tampered)).json();
  expect(done).toMatchObject({ added: 4, replaced: 0 });
  expect(done.skipped).toHaveLength(3);
  const view = await (await get(`/api/markets/${s.id}`)).json();
  expect(view.holdings.map((h: { symbol: string }) => h.symbol).sort()).toEqual(["AAPL", "KO", "SHOP", "XEQT"]);
  const big = await call("POST", `/api/markets/${s.id}/import/preview`, { csv: "x".repeat(2 * 1024 * 1024 + 1) });
  expect(big.status).toBe(413);
  expect(await big.json()).toEqual({ error: "That file is over 2 MB; export one account at a time." });
});

test("paper orders: refused outside the session, filled inside", async () => {
  boot();
  const s = markets();
  now = CLOSED;
  const closed = await call("POST", `/api/markets/${s.id}/paper/orders`, { symbol: "AAPL", side: "buy", qty: 1, reasoning: "test" });
  expect(closed.status).toBe(422);
  expect(await closed.json()).toEqual({ error: "Paper trades only fill while the US market is open." });
  now = IN_SESSION;
  await call("POST", `/api/markets/${s.id}/watchlist`, { key: "AAPL" });
  await get(`/api/markets/${s.id}`);
  const ok = await call("POST", `/api/markets/${s.id}/paper/orders`, { symbol: "AAPL", side: "buy", qty: 2, reasoning: "test" });
  expect(ok.status).toBe(200);
  expect((await ok.json()).fill).toMatchObject({ symbol: "AAPL", qty: 2, actor: "you", source: "demo" });
  expect((await call("POST", `/api/markets/${s.id}/paper/reset`, { startingCash: 50 })).status).toBe(400);
  expect((await call("POST", `/api/markets/${s.id}/paper/reset`, { startingCash: 20_000 })).status).toBe(200);
  const view = await (await get(`/api/markets/${s.id}`)).json();
  expect(view.paper.startingCash).toBe(20_000);
});

test("bars, backtests and strategies", async () => {
  boot();
  const s = markets();
  const bars = await (await get("/api/markets/bars?key=AAPL&range=3M")).json();
  expect(bars.timeframe).toBe("1Day");
  expect(bars.bars.length).toBeGreaterThan(50);
  expect((await get("/api/markets/bars?key=AAPL&range=2W")).status).toBe(400);
  const bt = await (await call("POST", `/api/markets/${s.id}/backtest`, { key: "AAPL", template: { kind: "sma_cross", fast: 5, slow: 20 }, range: "6M" })).json();
  expect(typeof bt.returnPct).toBe("number");
  const st = await (await call("POST", `/api/markets/${s.id}/strategies`, { name: "M", rules: "r", symbols: ["AAPL"], cadence: "hourly", maxPositionValue: 2000, maxTradesPerDay: 3 })).json();
  expect(st.status).toBe("draft");
  expect((await call("PATCH", `/api/markets/${s.id}/strategies/${st.id}`, { paused: true })).status).toBe(400);
});

test("market data settings: provider, test connection, no keys returned", async () => {
  boot();
  const s = await (await get("/api/settings/market-data")).json();
  expect(s.data.usProvider).toBe("demo");
  expect(s.feed.mode).toBeDefined();
  expect((await call("PUT", "/api/settings/market-data", { provider: "nope" })).status).toBe(400);
  const t = await (await call("POST", "/api/settings/market-data/test")).json();
  expect(t.us.ok).toBe(true);
  expect(t.us.sample.key).toBe("AAPL");
  expect(t.ca.sample.freshness).toBe("demo");
  const put = await (await call("PUT", "/api/settings/market-data", { provider: "finnhub" })).json();
  expect(put.data.usProvider).toBe("finnhub");
  const t2 = await (await call("POST", "/api/settings/market-data/test")).json();
  expect(t2.us).toEqual({ ok: false, message: "Add your Finnhub key in Settings → Market data." });
  const bad = await call("POST", "/api/settings/market-data/keys", { provider: "alpaca", keyId: "bad key", secret: "x" });
  expect(bad.status).toBe(400);
  expect(await bad.json()).toEqual({ error: "That doesn't look like an Alpaca key: keys are letters and numbers only." });
});

test("markets spaces are created private and stay private", async () => {
  boot();
  const r = await call("POST", "/api/spaces", { name: "Stocks", kind: "markets", goal: "watch" });
  const s = await r.json();
  expect(s).toMatchObject({ kind: "markets", private: true });
  const msg = { error: "Markets spaces stay private: your holdings only go to Claude." };
  const off = await call("PATCH", `/api/spaces/${s.id}`, { private: false });
  expect(off.status).toBe(400);
  expect(await off.json()).toEqual(msg);
  const made = await call("POST", "/api/spaces", { name: "Open", kind: "markets", goal: "", private: false });
  expect(made.status).toBe(400);
  expect(await made.json()).toEqual(msg);
  expect((await call("PATCH", `/api/spaces/${s.id}`, { name: "Renamed" })).status).toBe(200);
});

test("key canary: keys never leave the Keychain", async () => {
  const KEY_ID = "PKCANARY12345";
  const SECRET = "SKCANARY67890";
  const echo = (async (input: string | URL | Request, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    return new Response(`denied ${h.get("APCA-API-KEY-ID")} ${h.get("APCA-API-SECRET-KEY")} ${String(input)}`, { status: 401 });
  }) as unknown as typeof fetch;
  const { keychain, data } = boot({ demo: false, fetch: echo });
  await keychain.set("alpaca.keyId", KEY_ID);
  await keychain.set("alpaca.secret", SECRET);
  await data.reload();
  const errors: string[] = [];
  const spy = spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(" ")));
  try {
    const s = markets();
    const bodies: string[] = [];
    const record = async (r: Response) => bodies.push(await r.text());
    await record(await call("POST", `/api/markets/${s.id}/watchlist`, { key: "AAPL" }));
    await record(await get(`/api/markets/${s.id}`));
    await record(await get("/api/markets/bars?key=AAPL&range=1Y"));
    await record(await get("/api/markets/bars?key=AAPL&range=5D"));
    await record(await call("POST", "/api/settings/market-data/test"));
    await record(await get("/api/settings/market-data"));
    const saved = await call("POST", "/api/settings/market-data/keys", { provider: "alpaca", keyId: KEY_ID, secret: SECRET });
    expect(saved.status).toBe(422);
    await record(saved);
    await record(await call("POST", `/api/markets/${s.id}/paper/orders`, { symbol: "AAPL", side: "buy", qty: 1, reasoning: "x" }));
    const all = bodies.join("\n");
    expect(all).toContain("Alpaca rejected the key");
    for (const c of [KEY_ID, SECRET]) {
      expect(all).not.toContain(c);
      expect(errors.join("\n")).not.toContain(c);
    }
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const files = readdirSync(config().home).filter((f) => statSync(join(config().home, f)).isFile());
    for (const f of files) {
      const bytes = readFileSync(join(config().home, f), "latin1");
      expect(bytes).not.toContain(KEY_ID);
      expect(bytes).not.toContain(SECRET);
    }
    const rows = JSON.stringify([db.query("SELECT * FROM activity").all(), db.query("SELECT * FROM approvals").all(), db.query("SELECT * FROM settings").all()]);
    expect(rows).not.toContain(KEY_ID);
    expect(rows).not.toContain(SECRET);
  } finally {
    spy.mockRestore();
  }
});

test("a Tiingo key is validated, saved to the Keychain and removable", async () => {
  const { stubFetch, jsonResponse } = await import("../engine/markets/fakes");
  const tiingoRows = JSON.parse(readFileSync(join(FIXTURES, "investing/tiingo-spy.json"), "utf8"));
  const s = stubFetch((url) => (url.host === "api.tiingo.com" ? jsonResponse(tiingoRows) : new Response("no", { status: 500 })));
  const { keychain } = boot({ fetch: s.fetch });
  const saved = await call("POST", "/api/settings/market-data/keys", { provider: "tiingo", token: "TGTESTTOKEN99" });
  expect(saved.status).toBe(200);
  expect(await keychain.get("tiingo.token")).toBe("TGTESTTOKEN99");
  expect(s.calls[0]!.headers.authorization).toBe("Token TGTESTTOKEN99");
  const st = await (await get("/api/settings/market-data")).json();
  expect(st.data.keys.tiingo).toBe(true);
  expect(JSON.stringify(st)).not.toContain("TGTESTTOKEN99");
  expect((await call("DELETE", "/api/settings/market-data/keys/tiingo")).status).toBe(200);
  expect(await keychain.get("tiingo.token")).toBeNull();
});

test("no trading hosts anywhere in the source", () => {
  const banned = ["paper-api.alpaca.markets", "api.alpaca.markets", "/v2/orders"];
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [join(dir, e.name)] : []));
  const files = walk(resolve(import.meta.dir, "../../src"));
  expect(files.length).toBeGreaterThan(50);
  for (const f of files) {
    const text = readFileSync(f, "utf8").replaceAll("data.alpaca.markets", "").replaceAll("stream.data.alpaca.markets", "");
    for (const b of banned) expect(`${f}: ${text.includes(b)}`).toBe(`${f}: false`);
  }
});

test("no unlicensed sources anywhere in the source", () => {
  const banned = ["finance.yahoo.com", "query1.finance", "money.tmx.com", "google.com/finance", "stooq.", "api.nasdaq.com"];
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [join(dir, e.name)] : []));
  const files = walk(resolve(import.meta.dir, "../../src"));
  expect(files.length).toBeGreaterThan(50);
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const b of banned) expect(`${f}: ${b}: ${text.includes(b)}`).toBe(`${f}: ${b}: false`);
  }
});

test("an alert's Needs-you item can turn the alert off", async () => {
  boot();
  const s = markets();
  const a = await (await call("POST", `/api/markets/${s.id}/alerts`, { key: "AAPL", rule: { kind: "price_above", level: 1 } })).json();
  const { evaluateQuotes } = await import("../../src/engine/markets/alerts");
  const { listPending } = await import("../../src/engine/approvals");
  evaluateQuotes(db, [{ key: "AAPL", price: 5, prevClose: 4, at: now, source: "demo", freshness: "demo" }], now);
  const approval = listPending(db).find((x) => x.kind === "alert")!;
  const r = await call("POST", `/api/markets/${s.id}/alerts/off-from-approval`, { approvalId: approval.id });
  expect(r.status).toBe(200);
  const view = await (await get(`/api/markets/${s.id}`)).json();
  expect(view.alerts.find((x: { id: string }) => x.id === a.id).status).toBe("off");
  expect((await call("POST", `/api/markets/${s.id}/alerts/off-from-approval`, { approvalId: "apr_nope" })).status).toBe(404);
});

test("a cross-site page can't read market data or spend provider calls", async () => {
  setSetting(db, "markets.provider", "demo");
  let calls = 0;
  const demo = demoProvider({ now: () => now });
  const counting = { ...demo, bars: (...a: Parameters<typeof demo.bars>) => (calls++, demo.bars(...a)), quotes: (...a: Parameters<typeof demo.quotes>) => (calls++, demo.quotes(...a)) };
  const keychain = createKeychain(FAKE);
  const data = createMarketData({ db, keychain, now: () => now, providers: { demo: counting } });
  const feed = createFeed({ db, data, onQuotes: () => {}, strategyActive: () => false, now: () => now });
  server = startServer({ db, runner: { kick: () => {} }, setup: async () => { throw new Error("no"); }, port: 0, markets: { data, feed, keychain, kick: () => {}, now: () => now } });
  base = `http://127.0.0.1:${server.port}`;
  const cross = await fetch(`${base}/api/markets/bars?key=AAPL&range=1M`, { headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } });
  expect(cross.status).toBe(403);
  expect(calls).toBe(0);
  expect((await fetch(`${base}/api/markets/bars?key=AAPL&range=1M`)).status).toBe(200);
  expect(calls).toBe(1);
});

test("the Alpaca key pair is saved together or not at all", async () => {
  const ok = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
  const { keychain } = boot({ demo: false, fetch: ok });
  process.env.FAKE_SECURITY_FAIL_ACCOUNT = "alpaca.secret";
  try {
    const r = await call("POST", "/api/settings/market-data/keys", { provider: "alpaca", keyId: "PKFIRSTKEY123", secret: "SKFIRSTSECRET1" });
    expect(r.status).toBe(422);
    expect(await keychain.get("alpaca.keyId")).toBeNull();
  } finally {
    delete process.env.FAKE_SECURITY_FAIL_ACCOUNT;
  }
  await keychain.set("alpaca.keyId", "PKOLDKEY12345");
  await keychain.set("alpaca.secret", "SKOLDSECRET123");
  process.env.FAKE_SECURITY_FAIL_ACCOUNT = "alpaca.secret";
  try {
    expect((await call("POST", "/api/settings/market-data/keys", { provider: "alpaca", keyId: "PKNEWKEY12345", secret: "SKNEWSECRET123" })).status).toBe(422);
  } finally {
    delete process.env.FAKE_SECURITY_FAIL_ACCOUNT;
  }
  expect(await keychain.get("alpaca.keyId")).toBe("PKOLDKEY12345");
  expect(await keychain.get("alpaca.secret")).toBe("SKOLDSECRET123");
});

test("PUT provider alpaca is refused with the plain sentence", async () => {
  boot();
  const r = await call("PUT", "/api/settings/market-data", { provider: "alpaca" });
  expect(r.status).toBe(400);
  expect(await r.json()).toEqual({ error: "Alpaca isn't used anymore. Pick Finnhub or Demo." });
});

test("the test probe reports history", async () => {
  const { jsonResponse, fixture } = await import("../engine/markets/fakes");
  const hosts: string[] = [];
  const stub = (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    hosts.push(u.host);
    return u.host === "api.tiingo.com" ? jsonResponse(fixture("investing/tiingo-spy.json")) : new Response("no", { status: 500 });
  }) as unknown as typeof fetch;
  const { keychain, data } = boot({ demo: false, fetch: stub });
  setSetting(db, "markets.provider", "finnhub");
  const before = await (await call("POST", "/api/settings/market-data/test")).json();
  expect(before.history).toEqual({ ok: false, message: "Add a free Tiingo key for daily history (Settings → Market data)." });
  await keychain.set("tiingo.token", "TGTESTTOKEN99");
  await data.reload();
  const t = await (await call("POST", "/api/settings/market-data/test")).json();
  expect(t.history).toEqual({ ok: true, message: "Tiingo answered." });
  expect(hosts).toContain("api.tiingo.com");
});
