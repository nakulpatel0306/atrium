import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDb } from "../../src/engine/db";
import { setSetting } from "../../src/engine/settings";
import { createSpace } from "../../src/engine/spaces";
import { createMarketData } from "../../src/engine/markets/data";
import { createFeed } from "../../src/engine/markets/feed";
import { createKeychain } from "../../src/engine/markets/keychain";
import { demoProvider } from "../../src/engine/markets/providers/demo";
import { startServer } from "../../src/server/server";
import { tempHome } from "../helpers";

const FAKE = resolve(import.meta.dir, "../fixtures/fake-security.ts");
const DIR = resolve(import.meta.dir, "../fixtures/money");
const NOW = Date.parse("2026-11-05T16:00:00Z");

let home: ReturnType<typeof tempHome>;
let keyDir: string;
let db: Database;
let server: ReturnType<typeof startServer>;
let base: string;
let fetchCalls: string[];
let kicks: number;
let spaceId: string;

beforeEach(() => {
  home = tempHome();
  keyDir = mkdtempSync(join(tmpdir(), "atrium-keys-"));
  process.env.FAKE_SECURITY_STORE = join(keyDir, "store.json");
  db = openDb();
  fetchCalls = [];
  kicks = 0;
  setSetting(db, "markets.provider", "demo");
  const stub = (async (input: string | URL | Request) => {
    fetchCalls.push(String(input));
    throw new Error("no network");
  }) as unknown as typeof fetch;
  const keychain = createKeychain(FAKE);
  const data = createMarketData({ db, keychain, now: () => NOW, fetch: stub, providers: { demo: demoProvider({ now: () => NOW }) } });
  const feed = createFeed({ db, data, onQuotes: () => {}, strategyActive: () => false, now: () => NOW });
  server = startServer({ db, runner: { kick: () => {} }, setup: async () => { throw new Error("no"); }, port: 0, markets: { data, feed, keychain, kick: () => void kicks++, now: () => NOW, fetch: stub } });
  base = `http://127.0.0.1:${server.port}`;
  spaceId = createSpace(db, { name: "Investing", kind: "markets", goal: "g" }).id;
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
const money = (rest = "") => `/api/investing/${spaceId}/money${rest}`;
const csv = (name: string) => readFileSync(join(DIR, name), "utf8");

test("preview, import twice, then read the month — all without the network", async () => {
  const p = await (await call("POST", money("/preview"), { csv: csv("rbc.csv") })).json();
  expect(p).toMatchObject({ format: "bank", total: 40, signs: "negative-out" });
  expect(p.rows).toHaveLength(20);
  expect(await (await call("POST", money("/import"), { csv: csv("rbc.csv") })).json()).toMatchObject({ added: 40, duplicates: 0 });
  expect(await (await call("POST", money("/import"), { csv: csv("rbc.csv") })).json()).toMatchObject({ added: 0, duplicates: 40 });
  const v = await (await fetch(base + money("?month=2026-10"))).json();
  expect(v.month).toBe("2026-10");
  expect(v.spending.length).toBeGreaterThan(0);
  expect(v.starters).toHaveLength(4);
  expect(fetchCalls).toEqual([]);
});

test("bad input says what to do", async () => {
  const empty = await call("POST", money("/import"), { csv: "" });
  expect([empty.status, (await empty.json()).error]).toEqual([400, "Pick a CSV file or paste its contents."]);
  const unusable = await call("POST", money("/import"), { csv: "Name,Colour\nA,Red\n" });
  expect([unusable.status, (await unusable.json()).error]).toEqual([400, "Atrium couldn't find date, description and amount columns. Pick them below."]);
  const big = await call("POST", money("/preview"), { csv: "x".repeat(2 * 1024 * 1024 + 1) });
  expect(big.status).toBe(413);
});

test("rules can be read and replaced; the ask queues a Claude task", async () => {
  expect((await (await fetch(base + money("/rules"))).json()).length).toBeGreaterThan(10);
  expect(await (await call("PUT", money("/rules"), { rules: [{ match: "best buy", category: "Electronics" }] })).json()).toEqual([{ match: "best buy", category: "Electronics" }]);
  const bad = await call("PUT", money("/rules"), { rules: [{ match: "", category: "X" }] });
  expect(bad.status).toBe(400);
  const r = await (await call("POST", money("/ask"), { question: "Where did my money go last month?" })).json();
  expect(r.taskId).toMatch(/^tsk_/);
  expect(kicks).toBe(1);
  const again = await call("POST", money("/ask"), { question: "Again" });
  expect([again.status, (await again.json()).error]).toEqual([400, "Claude is already looking at your money."]);
});

test("a space that isn't markets has no money view", async () => {
  const general = createSpace(db, { name: "Docs", kind: "general", goal: "g" });
  const r = await fetch(`${base}/api/investing/${general.id}/money`);
  expect([r.status, (await r.json()).error]).toEqual([404, "No such markets space."]);
});

test("an oversized body is refused before it's parsed, with or without a Content-Length", async () => {
  const huge = JSON.stringify({ csv: "x".repeat(5 * 1024 * 1024) });
  const sized = await call("POST", money("/preview"), JSON.parse(huge));
  expect([sized.status, (await sized.json()).error]).toEqual([413, "That file is over 2 MB; export a shorter date range."]);
  // Streamed with no Content-Length: reading stops at the limit instead of taking in the whole body.
  const { readBody } = await import("../../src/server/http");
  const chunk = new Uint8Array(65536).fill(120);
  let pulled = 0;
  const stream = new ReadableStream({
    pull(c) {
      pulled++;
      if (pulled > 200) c.close();
      else c.enqueue(chunk);
    },
  });
  const req = new Request("http://127.0.0.1/x", { method: "POST", headers: { "content-type": "application/json" }, body: stream, duplex: "half" } as RequestInit);
  const err = await readBody(req, { bytes: 1024 * 1024, message: "too big" }).catch((e) => e);
  expect([err.status, err.message]).toEqual([413, "too big"]);
  expect(pulled).toBeLessThan(40);
});

// ---- Plan 14 ----

test("preview names the bank and the account; the account can be picked", async () => {
  const p = await (await call("POST", money("/preview"), { csv: csv("td-credit.csv") })).json();
  expect(p).toMatchObject({ bank: { id: "td", confidence: "medium" }, account: "TD credit card", choices: ["TD chequing", "TD credit card", "Amex", "Wealthsimple chequing", "Wealthsimple savings", "Imported"] });
  const picked = await (await call("POST", money("/preview"), { csv: csv("td-credit.csv"), account: "TD chequing" })).json();
  expect(picked.accounts).toEqual(["TD chequing"]);
});

test("the view carries the recap, subscriptions, TFSA room and budgets; transfers, budgets and Explain have routes", async () => {
  for (const f of ["td-chequing.csv", "td-credit.csv", "amex.csv", "ws-cash.csv"]) await call("POST", money("/import"), { csv: csv(f) });
  let v = await (await fetch(base + money())).json();
  expect(v.month).toBe("2026-10");
  expect(v.recap.lines[0]).toStartWith("You spent CA$");
  expect(v.subscriptions.list.length).toBeGreaterThan(5);
  expect(v.room.headline).toBe("Your 2026 TFSA room isn't set yet.");
  const best = v.transactions.find((t: { description: string }) => t.description.startsWith("BEST BUY"));
  expect(await (await call("POST", money("/transfer"), { id: best.id, transfer: true })).json()).toEqual({ ok: true });
  v = await (await fetch(base + money())).json();
  expect(v.transactions.find((t: { id: string }) => t.id === best.id)).toMatchObject({ transfer: "marked", mark: 1 });
  expect((await call("POST", money("/transfer"), { id: best.id, transfer: "yes" })).status).toBe(400);
  expect(await (await call("PUT", money("/budgets"), { category: "Dining", limit: 50 })).json()).toEqual([{ category: "Dining", limit: 50 }]);
  v = await (await fetch(base + money())).json();
  expect(v.budgets[0]).toMatchObject({ category: "Dining", limit: 50 });
  expect(await (await call("PUT", money("/budgets"), { category: "Dining", limit: null })).json()).toEqual([]);
  const ex = await call("POST", money("/explain"), { month: "2026-10" });
  expect(ex.status).toBe(200);
  expect(kicks).toBeGreaterThan(0);
  expect((await (await call("POST", money("/explain"), { month: "2026-10" })).json()).error).toBe("Claude is already looking at your money.");
  expect(fetchCalls).toEqual([]);
});

test("budget heads-ups and the reminder can be dismissed from the dashboard; summary carries them", async () => {
  // The summary shows a heads-up for two days by the wall clock; pin that to this file's engine clock.
  setSystemTime(new Date(NOW));
  try {
    await call("POST", money("/import"), { csv: "Date,Description,Amount\n2026-11-02,STARBUCKS,-90\n", signs: "negative-out" });
    await call("PUT", money("/budgets"), { category: "Dining", limit: 100 });
    const s = await (await fetch(`${base}/api/summary`)).json();
    expect(s.nudges).toEqual([expect.objectContaining({ kind: "budget", title: "Dining is at 90% of its November budget", path: `/space/${spaceId}?tab=money` })]);
    expect(s.needsYou).toBe(0);
    expect((await call("POST", money(`/nudges/${s.nudges[0].id}/dismiss`))).status).toBe(200);
    expect((await (await fetch(`${base}/api/summary`)).json()).nudges).toEqual([]);
    expect((await call("POST", money(`/nudges/${s.nudges[0].id}/dismiss`))).status).toBe(400);
  } finally {
    setSystemTime();
  }
});

test("card data: uploaded CSV text never comes back in an error, and isn't logged", async () => {
  const errors: string[] = [];
  const spy = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  try {
    const card = "4111 1111 1111 1111";
    for (const body of [{ csv: `Name,Colour\n${card},Red\n` }, { csv: `${card}\n` }, { csv: `Date,Description,Amount\nnot a date,${card},x\n` }]) {
      for (const path of ["/preview", "/import"]) {
        const res = await call("POST", money(path), body);
        const text = await res.text();
        expect(text.replace(/\s/g, "")).not.toContain("4111111111111111");
        expect(text).not.toContain(card);
      }
    }
    expect(errors.join("\n")).not.toContain("4111");
  } finally {
    console.error = spy;
  }
});

// ---- Imports: undo and change account ----

test("an import can be moved to the right account, dropping what it doubled, then undone", async () => {
  await call("POST", money("/import"), { csv: csv("td-chequing.csv") });
  await call("POST", money("/import"), { csv: csv("td-chequing-iso.csv"), account: "Imported" });
  let v = await (await fetch(base + money())).json();
  expect(v.imports.map((i: { account: string; rows: number }) => [i.account, i.rows])).toEqual([
    ["Imported", 11],
    ["TD chequing", 28],
  ]);
  expect(v.busy).toBe(false);
  expect(v.importAccounts).toEqual(["TD chequing", "TD credit card", "Amex", "Wealthsimple chequing", "Wealthsimple savings"]);
  const id = v.imports[0].id;
  const imp = (rest = "") => `/api/money/imports/${id}${rest}`;

  // The usual guards: a JSON body and our own origin.
  const plain = await fetch(base + imp("/account"), { method: "POST", headers: { origin: base, "content-type": "text/plain" }, body: '{"account":"TD chequing"}' });
  expect(plain.status).toBe(415);
  const foreign = await fetch(base + imp(), { method: "DELETE", headers: { origin: "http://evil.example" } });
  expect(foreign.status).toBe(403);
  const noOrigin = await fetch(base + imp(), { method: "DELETE" });
  expect(noOrigin.status).toBe(403);
  const unknown = await call("POST", imp("/account"), { account: "Somewhere else" });
  expect([unknown.status, (await unknown.json()).error]).toEqual([400, "Pick one of your accounts."]);

  expect(await (await call("POST", imp("/account"), { account: "TD chequing" })).json()).toEqual({ moved: 2, dropped: 9 });
  v = await (await fetch(base + money())).json();
  expect(v.imports.map((i: { account: string; rows: number }) => [i.account, i.rows])).toEqual([
    ["TD chequing", 2],
    ["TD chequing", 28],
  ]);

  expect(await (await call("DELETE", imp())).json()).toEqual({ removed: 2 });
  v = await (await fetch(base + money())).json();
  expect(v.imports).toHaveLength(1);
  expect(v.counts.bank).toBe(28);
  const gone = await call("DELETE", imp());
  expect([gone.status, (await gone.json()).error]).toEqual([404, "That import isn't here anymore. Refresh the page."]);
});

test("an import can't be undone or moved while Claude is looking at your money", async () => {
  await call("POST", money("/import"), { csv: csv("amex.csv") });
  await call("POST", money("/ask"), { question: "Where did my money go last month?" });
  const v = await (await fetch(base + money())).json();
  expect(v.busy).toBe(true);
  const id = v.imports[0].id;
  for (const res of [await call("DELETE", `/api/money/imports/${id}`), await call("POST", `/api/money/imports/${id}/account`, { account: "TD credit card" })]) {
    expect([res.status, (await res.json()).error]).toEqual([409, "Claude is looking at your money. Try again when it's done."]);
  }
  expect((await (await fetch(base + money())).json()).counts.bank).toBe(20);
});

test("a statement's file name, with its account id, is never stored", async () => {
  const name = "Fake Person's Savings-monthly-statement-transactions-WK000000000CAD-2026-10-01.csv";
  // Even sent alongside the file, the name is ignored.
  expect((await call("POST", money("/import"), { csv: csv("ws-savings-statement.csv"), name, filename: name })).status).toBe(200);
  db.exec("PRAGMA wal_checkpoint(PASSIVE)");
  const { readdirSync } = await import("node:fs");
  const raw = readdirSync(home.home)
    .filter((f) => f.includes(".db"))
    .map((f) => readFileSync(join(home.home, f)).toString("latin1"))
    .join("\n");
  expect(raw.includes("Interest")).toBe(true);
  for (const s of ["WK000000000CAD", "monthly-statement", "Fake Person"]) expect(raw.includes(s)).toBe(false);
});
