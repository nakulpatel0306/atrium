import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../src/engine/db";
import { addHolding } from "../../src/engine/markets/holdings";
import { createSpace } from "../../src/engine/spaces";
import { embedResponse, TV_FRAME_HOSTS, TV_SCRIPT, TV_SCRIPTS, tvConfig, widgetConfig } from "../../src/server/embed";
import { startServer } from "../../src/server/server";
import { tempHome } from "../helpers";

const REFUSED = "That chart link isn't valid. Open the symbol from Atrium again.";
const embed = (host: string, query: string) => {
  const url = new URL(`http://${host}/embed/tradingview?${query}`);
  return embedResponse(new Request(url, { headers: { host } }), url, 7571);
};
const q = (symbol: string, parent: string) => `symbol=${encodeURIComponent(symbol)}&parent=${encodeURIComponent(parent)}`;

test("serves TradingView's widget with a strict CSP framed only by the parent", async () => {
  const r = embed("localhost:7571", q("NASDAQ:AMZN", "http://127.0.0.1:7571"));
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
  const csp = r.headers.get("content-security-policy")!;
  expect(csp).toContain("default-src 'none'");
  expect(csp).toMatch(/script-src 'nonce-[A-Za-z0-9+/=]{24}' https:\/\/s3\.tradingview\.com;/);
  expect(csp).toContain("frame-src https://www.tradingview-widget.com https://s.tradingview.com;");
  expect(csp).toContain("connect-src 'none'");
  expect(csp).toContain("img-src 'none'");
  expect(csp).toContain("frame-ancestors http://127.0.0.1:7571");

  expect(r.headers.get("referrer-policy")).toBe("origin");
  expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  expect(r.headers.get("cache-control")).toBe("no-store");
  const body = await r.text();
  expect(body).toContain('"symbol":"NASDAQ:AMZN"');
  expect(body).toContain('"theme":"dark"');
  expect(body).toContain('"save_image":false');
  expect(body).toContain('href="https://www.tradingview.com/symbols/NASDAQ-AMZN/"');
  expect(body).toContain("AMZN chart</span></a> by TradingView");
  expect(body).toContain(`<script src="${TV_SCRIPT}" async>`);
  const nonce = csp.match(/'nonce-([^']+)'/)![1]!;
  expect(body).toContain(`<script nonce="${nonce}">`);
  const again = embed("localhost:7571", q("NASDAQ:AMZN", "http://127.0.0.1:7571"));
  expect(again.headers.get("content-security-policy")).not.toContain(nonce);
  expect(TV_FRAME_HOSTS).toEqual(["https://www.tradingview-widget.com", "https://s.tradingview.com"]);
  expect(tvConfig("TSX:XEQT")).toMatchObject({ symbol: "TSX:XEQT", interval: "D", timezone: "America/Toronto", allow_symbol_change: false, support_host: "https://www.tradingview.com" });
});

test("refuses the same origin as parent", async () => {
  const r = embed("127.0.0.1:7571", q("NASDAQ:AMZN", "http://127.0.0.1:7571"));
  expect([r.status, await r.text()]).toEqual([400, REFUSED]);
});

test("refuses a foreign parent", async () => {
  const r = embed("localhost:7571", q("NASDAQ:AMZN", "https://evil.example"));
  expect([r.status, await r.text()]).toEqual([400, REFUSED]);
  expect(embed("localhost:7571", q("NASDAQ:AMZN", "http://127.0.0.1:9999")).status).toBe(400);
});

test("refuses a bad symbol", async () => {
  const r = embed("localhost:7571", q('NASDAQ:AMZN"><script>', "http://127.0.0.1:7571"));
  expect([r.status, await r.text()]).toEqual([400, REFUSED]);
});

let home: ReturnType<typeof tempHome>;
let db: Database;
let server: ReturnType<typeof startServer> | undefined;
beforeEach(() => {
  home = tempHome();
  db = openDb();
});
afterEach(() => {
  server?.stop(true);
  server = undefined;
  db.close();
  home.cleanup();
});

test("the chart page has a listener of its own with no API, at a secret path the engine reports", async () => {
  server = startServer({ db, runner: { kick: () => {} }, setup: async () => { throw new Error("no"); }, port: 0 });
  const port = server.port;
  const ep = server.embedPort!;
  expect(ep).toBeGreaterThan(0);
  expect(ep).not.toBe(port);
  expect(server.embedToken).toMatch(/^[0-9a-f]{32}$/);
  const state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
  expect(state.embed).toEqual({ port: ep, token: server.embedToken });
  expect((await (await fetch(`http://127.0.0.1:${port}/api/summary`)).json()).embed).toEqual({ port: ep, token: server.embedToken });
  const query = `?${q("NASDAQ:AMZN", `http://127.0.0.1:${port}`)}`;
  const page = `/embed/${server.embedToken}/tradingview${query}`;
  const ok = await fetch(`http://127.0.0.1:${ep}${page}`, { headers: { host: `localhost:${ep}` } });
  expect(ok.status).toBe(200);
  expect((await fetch(`http://127.0.0.1:${ep}${page}`, { headers: { host: "evil.example" } })).status).toBe(403);
  // Without the token, or with another one, there's nothing there.
  expect((await fetch(`http://127.0.0.1:${ep}/embed/tradingview${query}`)).status).toBe(404);
  expect((await fetch(`http://127.0.0.1:${ep}/embed/${"0".repeat(32)}/tradingview${query}`)).status).toBe(404);
  for (const path of ["/api/state", "/api/summary", "/ws", "/"]) expect((await fetch(`http://127.0.0.1:${ep}${path}`)).status).toBe(404);
  expect((await fetch(`http://127.0.0.1:${ep}/api/spaces`, { method: "POST", body: "{}" })).status).toBe(404);
  // The engine's own port has no chart page.
  expect((await fetch(`http://127.0.0.1:${port}${page}`)).status).toBe(404);
  // Each launch gets a new token.
  const second = startServer({ db, runner: { kick: () => {} }, setup: async () => { throw new Error("no"); }, port: 0 });
  expect(second.embedToken).not.toBe(server.embedToken);
  second.stop(true);
});

test("a chart listener that can't bind is reported as null", async () => {
  const squatter = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("squatter") });
  const free = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const enginePort = squatter.port! - 1;
  free.stop(true);
  const errors: string[] = [];
  const spy = spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(" ")));
  try {
    server = startServer({ db, runner: { kick: () => {} }, setup: async () => { throw new Error("no"); }, port: enginePort });
    expect(server.embedPort).toBeNull();
    expect((await (await fetch(`http://127.0.0.1:${enginePort}/api/state`)).json()).embed).toBeNull();
    expect(errors.join("\n")).toContain("couldn't start");
  } catch (e) {
    // The engine port itself was taken between the probe and the start; nothing to check this run.
    if (!String(e).includes("EADDRINUSE")) throw e;
  } finally {
    spy.mockRestore();
    squatter.stop(true);
  }
});

test("the page carries nothing but the symbol", async () => {
  const s = createSpace(db, { name: "Investing", kind: "markets", goal: "g" });
  addHolding(db, s.id, { account: "TFSA", symbol: "AMZN", exchange: "US", name: "Amazon", quantity: 4817, bookValue: 93021, currency: "USD" });
  const body = await embed("localhost:7571", q("NASDAQ:AMZN", "http://127.0.0.1:7571")).text();
  expect(body).not.toContain("4817");
  expect(body).not.toContain("93021");
  expect(body).not.toContain("/api/");
  expect(body).not.toContain("TFSA");
});

test("nothing in the embed's context can reach the API or the socket", async () => {
  server = startServer({ db, runner: { kick: () => {} }, setup: async () => { throw new Error("no"); }, port: 0 });
  const port = server.port;
  const base = `http://127.0.0.1:${port}`;
  const embedOrigin = `http://localhost:${server.embedPort}`;
  const embedPage = `${embedOrigin}/embed/${server.embedToken}/tradingview?symbol=NASDAQ%3AAMZN&parent=${encodeURIComponent(base)}`;
  // What the chart page's scripts would send: their own origin, the page as Referer, Sec-Fetch-Site same-site.
  const asEmbed = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { origin: embedOrigin, referer: embedPage, "sec-fetch-site": "same-site", ...(init.headers as Record<string, string>) } });
  expect((await asEmbed("/api/state")).status).toBe(403);
  expect((await asEmbed("/api/spaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "x", kind: "general" }) })).status).toBe(403);
  expect((await asEmbed("/ws")).status).toBe(403);
  // Origin null (a sandboxed frame) and the chart listener's origin as Referer are each refused too.
  expect((await fetch(`${base}/api/state`, { headers: { origin: "null" } })).status).toBe(403);
  expect((await fetch(`${base}/api/state`, { headers: { referer: `${embedOrigin}/` } })).status).toBe(403);
  expect((await fetch(`${base}/api/summary`, { headers: { referer: `${embedOrigin}/` } })).status).toBe(403);
  // The dashboard and plain reads still work.
  expect((await fetch(`${base}/api/state`)).status).toBe(200);
  expect((await fetch(`${base}/api/state`, { headers: { origin: base, referer: `${base}/space/x` } })).status).toBe(200);
});

test("each TradingView widget kind gets its own script, config and attribution", async () => {
  const cases: [string, string, string, Record<string, unknown>][] = [
    ["mini", "embed-widget-mini-symbol-overview.js", "AMZN price", { symbol: "NASDAQ:AMZN", chartOnly: true, dateRange: "1M", colorTheme: "dark", isTransparent: false }],
    ["info", "embed-widget-symbol-info.js", "AMZN price", { symbol: "NASDAQ:AMZN", colorTheme: "dark" }],
    ["profile", "embed-widget-symbol-profile.js", "AMZN profile", { symbol: "NASDAQ:AMZN", colorTheme: "dark" }],
    ["financials", "embed-widget-financials.js", "AMZN fundamentals", { symbol: "NASDAQ:AMZN", displayMode: "regular" }],
    ["timeline", "embed-widget-timeline.js", "AMZN news", { symbol: "NASDAQ:AMZN", feedMode: "symbol" }],
  ];
  for (const [w, script, label, config] of cases) {
    const r = embed("localhost:7571", `${q("NASDAQ:AMZN", "http://127.0.0.1:7571")}&w=${w}`);
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain(`<script src="https://s3.tradingview.com/external-embedding/${script}" async>`);
    expect(body).toContain(`${label}</span></a> by TradingView`);
    expect(TV_SCRIPTS[w as keyof typeof TV_SCRIPTS] as string).toBe(`https://s3.tradingview.com/external-embedding/${script}`);
    expect(widgetConfig(w as keyof typeof TV_SCRIPTS, "NASDAQ:AMZN")).toMatchObject(config);
  }
  // No w is the chart; an unknown one is refused.
  expect(await embed("localhost:7571", q("NASDAQ:AMZN", "http://127.0.0.1:7571")).text()).toContain("embed-widget-advanced-chart.js");
  const bad = embed("localhost:7571", `${q("NASDAQ:AMZN", "http://127.0.0.1:7571")}&w=ticker`);
  expect([bad.status, await bad.text()]).toEqual([400, REFUSED]);
});

// The embed page sends Referrer-Policy: origin, so a browser's Referer from it is just "http://localhost:<port>/".
test("a request whose Origin or Referer is the chart listener's origin is refused", async () => {
  server = startServer({ db, runner: { kick: () => {} }, setup: async () => { throw new Error("no"); }, port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  for (const host of ["localhost", "127.0.0.1"]) {
    const embed = `http://${host}:${server.embedPort}`;
    expect((await fetch(`${base}/api/state`, { headers: { referer: `${embed}/` } })).status).toBe(403);
    expect((await fetch(`${base}/api/state`, { headers: { origin: embed } })).status).toBe(403);
  }
  expect((await fetch(`${base}/api/state`, { headers: { referer: `${base}/space/x` } })).status).toBe(200);
});
