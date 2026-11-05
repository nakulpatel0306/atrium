import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { listPending, resolveApproval } from "../../../src/engine/approvals";
import { openDb } from "../../../src/engine/db";
import { createSpace, updateSpace } from "../../../src/engine/spaces";
import { createAlert, describeRule, evaluateQuotes, listAlerts, setAlertStatus } from "../../../src/engine/markets/alerts";
import { saveBars } from "../../../src/engine/markets/cache";
import { etInstant } from "../../../src/engine/markets/calendar";
import type { Quote } from "../../../src/engine/markets/providers/types";
import { tempHome } from "../../helpers";

let home: ReturnType<typeof tempHome>;
let db: Database;
let spaceId: string;
const NOW = Date.parse("2026-11-05T15:00:00Z");

beforeEach(() => {
  home = tempHome();
  db = openDb();
  spaceId = createSpace(db, { name: "Stocks", kind: "markets", goal: "watch" }).id;
});
afterEach(() => {
  db.close();
  home.cleanup();
});

const q = (price: number, extra: Partial<Quote> = {}): Quote => ({ key: "AAPL", price, prevClose: 200, at: NOW, source: "alpaca", freshness: "live", ...extra });
const alerts = () => listPending(db).filter((a) => a.kind === "alert");

test("describeRule", () => {
  expect(describeRule({ kind: "price_above", level: 200 })).toBe("price above $200.00");
  expect(describeRule({ kind: "price_below", level: 9.5 })).toBe("price below $9.50");
  expect(describeRule({ kind: "pct_move", pct: 5 })).toBe("moves 5% in a day");
  expect(describeRule({ kind: "rsi_below", level: 30, period: 14 })).toBe("RSI(14) below 30");
  expect(describeRule({ kind: "rsi_above", level: 70, period: 14 })).toBe("RSI(14) above 70");
  expect(describeRule({ kind: "cross_above_sma", period: 50 })).toBe("crosses above SMA 50");
  expect(describeRule({ kind: "cross_below_sma", period: 20 })).toBe("crosses below SMA 20");
});

test("createAlert validates", () => {
  expect(() => createAlert(db, { spaceId, key: "AAPL", rule: { kind: "price_above", level: 0 } })).toThrow();
  expect(() => createAlert(db, { spaceId, key: "AAPL", rule: { kind: "pct_move", pct: 60 } })).toThrow();
  expect(() => createAlert(db, { spaceId, key: "AAPL", rule: { kind: "rsi_below", level: 30, period: 1 } })).toThrow();
  const a = createAlert(db, { spaceId, key: "aapl", rule: { kind: "price_above", level: 200 }, note: "trim" });
  expect(a).toMatchObject({ key: "AAPL", status: "armed", repeat: true, note: "trim" });
  expect(listAlerts(db, spaceId)).toHaveLength(1);
});

test("price_above fires once while hovering, re-arms after a 0.5% move back", () => {
  createAlert(db, { spaceId, key: "AAPL", rule: { kind: "price_above", level: 200 }, note: "take profit" });
  let fired = 0;
  for (const p of [199.9, 200.1, 199.95, 200.2, 200.05]) fired += evaluateQuotes(db, [q(p)], NOW);
  expect(fired).toBe(1);
  expect(alerts()).toHaveLength(1);
  const a = alerts()[0]!;
  expect(a.title).toBe("AAPL price above $200.00");
  expect(a.detail).toContain("AAPL at $200.10 (Alpaca · IEX real-time, 10:00 AM ET). Your alert: price above $200.00. Note: take profit");
  expect(a.detail).toContain("Analysis, not advice.");
  resolveApproval(db, a.id, "approve");
  evaluateQuotes(db, [q(198.9)], NOW);
  evaluateQuotes(db, [q(200.3)], NOW);
  expect(alerts()).toHaveLength(1);
  expect(alerts()[0]!.id).not.toBe(a.id);
});

test("repeat:false turns off after the first fire", () => {
  const a = createAlert(db, { spaceId, key: "AAPL", rule: { kind: "price_below", level: 100 }, repeat: false });
  evaluateQuotes(db, [q(99)], NOW);
  expect(listAlerts(db, spaceId)[0]!.status).toBe("off");
  evaluateQuotes(db, [q(101)], NOW);
  evaluateQuotes(db, [q(98)], NOW);
  expect(alerts()).toHaveLength(1);
  expect(setAlertStatus(db, a.id, "armed").status).toBe("armed");
});

test("pct_move fires once per ET date and needs a previous close", () => {
  createAlert(db, { spaceId, key: "AAPL", rule: { kind: "pct_move", pct: 5 } });
  expect(evaluateQuotes(db, [q(190, { prevClose: null })], NOW)).toBe(0);
  expect(evaluateQuotes(db, [q(189.8)], NOW)).toBe(1);
  expect(evaluateQuotes(db, [q(185)], NOW + 60_000)).toBe(0);
  resolveApproval(db, alerts()[0]!.id, "approve");
  expect(evaluateQuotes(db, [q(185, { at: NOW + 86_400_000 })], NOW + 86_400_000)).toBe(1);
});

const day = (date: string, c: number) => ({ t: etInstant(date, "00:00") / 1000, o: c, h: c, l: c, c, v: 1 });

test("rsi_below uses cached bars plus the quote", () => {
  const dates = Array.from({ length: 20 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`);
  saveBars(db, "AAPL", "1Day", dates.map((d, i) => day(d, 200 - i)));
  createAlert(db, { spaceId, key: "AAPL", rule: { kind: "rsi_below", level: 30, period: 14 } });
  expect(evaluateQuotes(db, [q(178)], NOW)).toBe(1);
});

test("cross_above_sma fires on the cross and only evaluates once a minute", () => {
  saveBars(db, "AAPL", "1Day", [day("2026-11-02", 10), day("2026-11-03", 10), day("2026-11-04", 9)]);
  const a = createAlert(db, { spaceId, key: "AAPL", rule: { kind: "cross_above_sma", period: 3 } });
  expect(evaluateQuotes(db, [q(11)], NOW)).toBe(1);
  setAlertStatus(db, a.id, "armed");
  expect(evaluateQuotes(db, [q(11)], NOW + 10_000)).toBe(0);
  resolveApproval(db, alerts()[0]!.id, "approve");
  // Once a session for indicator rules: the same day stays quiet, the next session can fire again.
  expect(evaluateQuotes(db, [q(11)], NOW + 61_000)).toBe(0);
  setAlertStatus(db, a.id, "armed");
  expect(evaluateQuotes(db, [q(11, { at: NOW + 86_400_000 })], NOW + 86_400_000)).toBe(1);
});

test("demo and eod labels; eod evaluates once per new at", () => {
  createAlert(db, { spaceId, key: "AAPL", rule: { kind: "price_above", level: 100 } });
  evaluateQuotes(db, [q(150, { source: "demo", freshness: "demo" })], NOW);
  expect(alerts()[0]!.detail).toContain("(Demo data, 10:00 AM ET)");
  createAlert(db, { spaceId, key: "SHOP.TO", rule: { kind: "price_below", level: 100 } });
  const eod = { key: "SHOP.TO", price: 90, prevClose: 95, at: Date.parse("2026-11-04T21:00:00Z"), source: "alphavantage" as const, freshness: "eod" as const };
  expect(evaluateQuotes(db, [eod], NOW)).toBe(1);
  expect(alerts()[0]!.detail).toContain("SHOP.TO at CA$90.00 (Alpha Vantage · close of Nov 4, 4:00 PM ET)");
});

test("off alerts and archived spaces never fire", () => {
  const a = createAlert(db, { spaceId, key: "AAPL", rule: { kind: "price_above", level: 100 } });
  setAlertStatus(db, a.id, "off");
  expect(evaluateQuotes(db, [q(150)], NOW)).toBe(0);
  setAlertStatus(db, a.id, "armed");
  updateSpace(db, spaceId, { status: "archived" });
  expect(evaluateQuotes(db, [q(150)], NOW)).toBe(0);
});

test("a price chopping around an indicator level gives at most one item per session", () => {
  saveBars(db, "AAPL", "1Day", [day("2026-11-02", 100), day("2026-11-03", 100), day("2026-11-04", 100)]);
  createAlert(db, { spaceId, key: "AAPL", rule: { kind: "cross_above_sma", period: 3 } });
  createAlert(db, { spaceId, key: "AAPL", rule: { kind: "rsi_above", level: 50, period: 2 } });
  createAlert(db, { spaceId, key: "AAPL", rule: { kind: "price_above", level: 100 } });
  const open = Date.parse("2026-11-05T14:30:00Z");
  for (let m = 0; m < 300; m++) {
    const at = open + m * 60_000;
    evaluateQuotes(db, [q(m % 2 ? 100.2 : 99.8, { at })], at);
  }
  const byTitle = new Map<string, number>();
  for (const a of alerts()) byTitle.set(a.title, (byTitle.get(a.title) ?? 0) + 1);
  for (const n of byTitle.values()) expect(n).toBeLessThanOrEqual(1);
  expect(alerts().length).toBeGreaterThan(0);
});

test("no second item while the first is still waiting in Needs you", () => {
  createAlert(db, { spaceId, key: "AAPL", rule: { kind: "price_above", level: 100 } });
  evaluateQuotes(db, [q(101)], NOW);
  evaluateQuotes(db, [q(99)], NOW + 60_000);
  evaluateQuotes(db, [q(101)], NOW + 120_000);
  expect(alerts()).toHaveLength(1);
  resolveApproval(db, alerts()[0]!.id, "approve");
  evaluateQuotes(db, [q(99)], NOW + 180_000);
  evaluateQuotes(db, [q(101)], NOW + 240_000);
  expect(alerts()).toHaveLength(1);
});
