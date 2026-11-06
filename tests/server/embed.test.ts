import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../src/engine/db";
import { addHolding } from "../../src/engine/markets/holdings";
import { createSpace } from "../../src/engine/spaces";
import { embedResponse, TV_FRAME_HOSTS, TV_SCRIPT, tvConfig } from "../../src/server/embed";
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

test("refuses a foreign Host", async () => {
  server = startServer({ db, runner: { kick: () => {} }, setup: async () => { throw new Error("no"); }, port: 0 });
  const port = server.port;
  const ok = await fetch(`http://127.0.0.1:${port}/embed/tradingview?${q("NASDAQ:AMZN", `http://127.0.0.1:${port}`)}`, { headers: { host: `localhost:${port}` } });
  expect(ok.status).toBe(200);
  const bad = await fetch(`http://127.0.0.1:${port}/embed/tradingview?${q("NASDAQ:AMZN", `http://127.0.0.1:${port}`)}`, { headers: { host: "evil.example" } });
  expect(bad.status).toBe(403);
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
