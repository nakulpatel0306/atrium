import { afterEach, expect, test } from "bun:test";
import { cleanup } from "ink-testing-library";
import type { State } from "../../src/engine/state";
import { type FakeClient, fakeClient } from "./fake-client";
import { ids, makeState, space } from "./fixtures";
import { KEY, openApp } from "./harness";

afterEach(() => cleanup());

const INV = "spc_inv";
const NOW = Date.parse("2026-11-05T16:00:00Z");

const glance = {
  portfolio: { totalCad: 48210.55, dayCad: 590, dayPct: 1.24, dayLabel: "today", mix: "62% US · 38% Canada" },
  lists: [{ name: "Watching", rows: [{ key: "NVDA", price: 141.2, ccy: "USD" as const, dayPct: -2.1, tag: "delayed" }] }],
  earnings: [{ key: "RKLB", date: "2026-11-09", hour: "amc", held: true }],
  advanced: false,
  paper: null,
};
const sourced = (value: number) => ({ value, source: "demo", asOf: NOW, tone: "demo" as const });
const holding = (key: string, price: number, dayPct: number, valueCad: number, weightPct: number) => ({
  key, symbol: key, exchange: "US", name: key, price: sourced(price), dayPct, spark: [], missing: null, tv: key, quantity: 10, valueCad, gainCad: 10, gainCadPct: 1, weightPct,
});
const portfolio = {
  total: sourced(48210.55), dayCad: 590, dayPct: 1.24, dayLabel: "today", mix: "62% US · 38% Canada", fx: null,
  holdings: [holding("SHOP.TO", 128.5, 1.9, 12850, 27), holding("SPY", 590.1, 0.4, 8300, 17)], gain: { cad: 4200, bookCad: 44000, pct: 9.5, complete: true }, note: null, empty: false, left: null,
};
const alerts = [{ id: "alr_1", spaceId: INV, key: "NVDA", rule: { kind: "price_below", level: 130 }, note: "", repeat: false, status: "armed", lastFiredAt: null, createdAt: NOW }];

function withInvesting(): State {
  const s = makeState();
  s.spaces.push(space({ id: INV, name: "Investing", kind: "markets", private: true }));
  return s;
}

function investingClient(state = withInvesting()): FakeClient {
  const client = fakeClient(state);
  const base = `/api/investing/${INV}`;
  client.respond(`${base}/glance`, { ok: true, data: glance });
  client.respond(`${base}/portfolio`, { ok: true, data: portfolio });
  client.respond(`/api/markets/${INV}`, { ok: true, data: { alerts } });
  return client;
}

const mutations = (calls: FakeClient["calls"]) => calls.filter((c) => c.method !== "GET" && c.path !== "/api/seen");

test("Home's Today shows the portfolio glance", async () => {
  const app = openApp(investingClient());
  const f = await app.frame((f) => f.includes("CA$48,211"));
  expect(f).toContain("▲ +1.2%");
  expect(f).toContain("62% US · 38% Canada");
  expect(f).toContain("RKLB earnings 11/09, after close");
});

test("Investing: the portfolio in CAD with today's change, holdings, watchlist, alerts and earnings", async () => {
  const client = investingClient();
  const app = openApp(client);
  await app.frame((f) => f.includes("1 Home"));
  await app.type("3");
  const f = await app.frame((f) => f.includes("HOLDINGS") && f.includes("ALERTS"));
  expect(f).toContain("Portfolio CA$48,211");
  expect(f).toContain("▲ +1.2% today (+CA$590)");
  expect(f).toMatch(/▌ SHOP\.TO\s+CA\$128\.50\s+▲ \+1\.9%\s+CA\$12,850\s+27%/);
  expect(f).toContain("WATCHING");
  expect(f).toMatch(/NVDA\s+US\$141\.20\s+▼ −2\.1%\s+delayed/);
  expect(f).toContain("○ NVDA price below $130.00  armed");
  expect(f).toContain("RKLB  after close  · you hold this");
  expect(f).toContain("Ask Claude about SHOP.TO");
  // Read-only: opening the tab changes nothing.
  expect(mutations(client.calls)).toEqual([]);
  await app.type("j", "j", " ", "why down?", KEY.enter);
  await app.frame((f) => f.includes("Asked Claude about NVDA."));
  expect(mutations(client.calls)).toEqual([{ method: "POST", path: `/api/investing/${INV}/symbol/NVDA/ask`, body: { question: "why down?" } }]);
});

test("clicks: a tab switches, a card selects, a card's key acts, a row picks, the Ask box takes the cursor", async () => {
  const state = makeState();
  const second = { ...state.approvals[0]!, id: "apr_two", title: "Review: Second thing", taskId: null };
  const client = fakeClient({ ...state, approvals: [state.approvals[0]!, second] });
  const app = openApp(client);
  const f = await app.frame((f) => f.includes("NEEDS YOU  2"));
  const lines = f.split("\n");
  // The second card's title row: clicking it selects it, and its actions appear.
  const y = lines.findIndex((l) => l.includes("Review: Second thing"));
  await app.click(10, y);
  const picked = await app.frame((f) => f.split("\n").some((l) => l.includes("Second thing") && l.includes("╭")) && f.indexOf(" a  Approve") > f.indexOf("Second thing"));
  // Its Approve key cap acts on it.
  const capY = picked.split("\n").findIndex((l, i) => i > y && l.includes(" a  Approve"));
  const capX = picked.split("\n")[capY]!.indexOf(" a  Approve");
  await app.click(capX + 2, capY);
  await app.frame((f) => f.includes('Approved "Review: Second thing".'));
  expect(mutations(client.calls)).toEqual([{ method: "POST", path: "/api/approvals/apr_two", body: { decision: "approve" } }]);
  // The Spaces tab, then the job hunt row.
  const tabX = lines[0]!.indexOf("2 Spaces");
  await app.click(tabX, 0);
  const spaces = await app.frame((f) => f.includes("TASKS · atrium"));
  await app.click(4, spaces.split("\n").findIndex((l) => l.includes("job hunt")));
  await app.frame((f) => f.includes("TASKS · job hunt"));
  // The Ask box.
  await app.click(10, 33);
  await app.type("hello");
  await app.frame((f) => f.includes("› hello"));
});

test("clicks: a key cap on the strip presses its key, and the wheel moves the list", async () => {
  const app = openApp(fakeClient(makeState()));
  const f = await app.frame((f) => f.includes("1 Home"));
  const strip = f.split("\n").at(-1)!;
  await app.click(strip.indexOf("?  help") + 1, 35);
  await app.frame((f) => f.includes("Keys") && f.includes("switch tab"));
  await app.type("?", "2");
  await app.frame((f) => f.includes("TASKS · atrium"));
  await app.wheel(5, 4, 1);
  await app.frame((f) => f.includes("TASKS · job hunt"));
});

test("every tab fits 80×24 exactly", async () => {
  const app = openApp(investingClient(), { columns: 80, rows: 24 });
  await app.frame((f) => f.includes("1 Home"));
  for (const tab of ["1", "2", "3", "4"]) {
    await app.type(tab);
    await new Promise((r) => setTimeout(r, 30));
    const lines = (app.lastFrame() ?? "").split("\n");
    expect(lines).toHaveLength(24);
    for (const l of lines) expect(Bun.stringWidth(l)).toBeLessThanOrEqual(80);
  }
});

test("the stop confirm says what happens, and y stops the task", async () => {
  const client = fakeClient(makeState());
  client.respond(`/api/tasks/${ids.running}/stop`, { ok: true, data: { status: "blocked" } });
  const app = openApp(client);
  await app.frame((f) => f.includes("1 Home"));
  await app.type(".");
  const f = await app.frame((f) => f.includes("Stop a running task"));
  expect(f).toContain('Stop "Add the status bar" now?');
  expect(f.replace(/[│\s]+/g, " ")).toContain("Its edits so far are kept");
  expect(f).toContain(" y  Stop it");
  await app.type("y");
  await app.frame((f) => f.includes('Stopped "Add the status bar".'));
  expect(mutations(client.calls)).toEqual([{ method: "POST", path: `/api/tasks/${ids.running}/stop` }]);
});

test("while the Ask box is open the wheel never types, and a card's key cap acts instead of typing", async () => {
  const client = fakeClient(makeState());
  const app = openApp(client);
  const f = await app.frame((f) => f.includes(" a  Approve"));
  await app.type(" ", "hello");
  await app.frame((f) => f.includes("› hello"));
  await app.wheel(5, 8, 1);
  await app.wheel(5, 8, 1);
  await new Promise((r) => setTimeout(r, 30));
  expect(app.lastFrame()).toContain("› hello");
  expect(app.lastFrame()).not.toContain("› helloj");
  const capY = f.split("\n").findIndex((l) => l.includes(" a  Approve"));
  const capX = f.split("\n")[capY]!.indexOf(" a  Approve");
  await app.click(capX + 2, capY);
  await app.frame((f) => f.includes('Approved "Review: Fix login redirect".'));
  expect(app.lastFrame()).not.toContain("› helloa");
  expect(mutations(client.calls)).toEqual([{ method: "POST", path: `/api/approvals/${ids.approval}`, body: { decision: "approve" } }]);
});

test("the strip's own keys still reach the Ask box: a click on esc leaves it", async () => {
  const app = openApp(fakeClient(makeState()));
  await app.frame((f) => f.includes("1 Home"));
  await app.type(" ", "draft");
  const f = await app.frame((f) => f.includes("› draft") && f.includes("esc  cancel"));
  const strip = f.split("\n").at(-1)!;
  await app.click(strip.indexOf("esc  cancel") + 1, 35);
  await app.frame((f) => !f.includes("› draft") && f.includes("Describe something new"));
});
