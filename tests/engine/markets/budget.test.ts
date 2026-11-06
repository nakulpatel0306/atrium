import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../../src/engine/db";
import { dataBudget, hourlyBudget, meteredFetch, noteSourceResult, planAlphaVantage, SOURCE_INFO } from "../../../src/engine/markets/budget";
import { tempHome } from "../../helpers";
import { jsonResponse, stubFetch } from "./fakes";

let home: ReturnType<typeof tempHome>;
let db: Database;
beforeEach(() => {
  home = tempHome();
  db = openDb();
});
afterEach(() => {
  db.close();
  home.cleanup();
});

const WED_NOON = Date.parse("2026-11-04T17:00:00Z");

test("meteredFetch counts each call per source and ET date", async () => {
  let now = WED_NOON;
  const s = stubFetch(() => jsonResponse({}));
  const f = meteredFetch(db, "finnhub", s.fetch, () => now);
  for (let i = 0; i < 3; i++) await f("https://finnhub.io/api/v1/quote");
  expect(s.calls).toHaveLength(3);
  const row = (at: number) => dataBudget(db, at).find((r) => r.source === "finnhub")!;
  expect(row(now).callsToday).toBe(3);
  expect(row(now).label).toBe("Finnhub");
  now += 86_400_000;
  expect(row(now).callsToday).toBe(0);
  await f("https://finnhub.io/api/v1/quote");
  expect(row(now).callsToday).toBe(1);
  // Old dates are dropped as the counter moves on.
  expect((db.query("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'markets.calls.finnhub.%'").get() as { n: number }).n).toBe(1);
});

test("dataBudget lists every source in a fixed order with its last result", () => {
  noteSourceResult(db, "boc", false, "Couldn't reach Bank of Canada.", WED_NOON);
  noteSourceResult(db, "ishares", true, undefined, WED_NOON);
  const rows = dataBudget(db, WED_NOON);
  expect(rows.map((r) => r.source)).toEqual(["alpaca", "finnhub", "alphavantage", "tiingo", "yahoo", "boc", "ishares", "ssga", "roundhill", "invesco", "wikipedia", "edgar"]);
  expect(rows.find((r) => r.source === "boc")!.lastError).toBe("Couldn't reach Bank of Canada.");
  expect(rows.find((r) => r.source === "ishares")!.lastOkAt).toBe(WED_NOON);
  expect(rows.find((r) => r.source === "alphavantage")!.perDay).toBe(25);
  expect(rows.find((r) => r.source === "edgar")!.perDay).toBeNull();
  expect(SOURCE_INFO.tiingo.limit).toBe("1,000 a day, 50 an hour");
  const yahoo = rows.find((r) => r.source === "yahoo")!;
  expect(yahoo.label).toBe("Yahoo Finance");
  expect(yahoo.perDay).toBe(2000);
  expect(yahoo.limit).toBe("unofficial, no fixed limit; Atrium stops at 2,000 a day and pauses 15 minutes after an error");
});

test("hourlyBudget refuses past its limit until the next hour", () => {
  let now = WED_NOON;
  const b = hourlyBudget(db, "tiingo", 2, () => now);
  expect(b.spend()).toBe(true);
  expect(b.spend()).toBe(true);
  expect(b.spend()).toBe(false);
  expect(b.remaining()).toBe(0);
  now += 3_600_000;
  expect(b.spend()).toBe(true);
});

test("planAlphaVantage puts held symbols first and keeps the reserve", () => {
  const i = { held: ["ATZ.TO", "VFV.TO", "XEQT.TO"], watched: ["SHOP.TO", "VFV.TO"], used: 0, limit: 25, reserve: 5 };
  expect(planAlphaVantage(i)).toEqual({ eod: ["ATZ.TO", "VFV.TO", "XEQT.TO", "SHOP.TO"], deferred: [], spare: 16 });
  expect(planAlphaVantage({ ...i, used: 18 })).toEqual({ eod: ["ATZ.TO", "VFV.TO"], deferred: ["XEQT.TO", "SHOP.TO"], spare: 0 });
  expect(planAlphaVantage({ ...i, used: 30 })).toEqual({ eod: [], deferred: ["ATZ.TO", "VFV.TO", "XEQT.TO", "SHOP.TO"], spare: 0 });
});

test("a provider's new error goes to the engine log once, redacted by the caller, and its recovery once", () => {
  const err = spyOn(console, "error").mockImplementation(() => {});
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    noteSourceResult(db, "alphavantage", false, "Alpha Vantage asked Atrium to slow down; it will try again in a minute.", WED_NOON);
    noteSourceResult(db, "alphavantage", false, "Alpha Vantage asked Atrium to slow down; it will try again in a minute.", WED_NOON + 60_000);
    noteSourceResult(db, "alphavantage", true, undefined, WED_NOON + 120_000);
    noteSourceResult(db, "alphavantage", true, undefined, WED_NOON + 180_000);
    expect(err.mock.calls.map((c) => c[0])).toEqual(["Alpha Vantage: Alpha Vantage asked Atrium to slow down; it will try again in a minute."]);
    expect(log.mock.calls.map((c) => c[0])).toEqual(["Alpha Vantage is working again."]);
  } finally {
    err.mockRestore();
    log.mockRestore();
  }
});
