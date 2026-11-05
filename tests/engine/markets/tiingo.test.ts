import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../../src/engine/db";
import { dailyBudget, hourlyBudget } from "../../../src/engine/markets/budget";
import { etInstant } from "../../../src/engine/markets/calendar";
import { tiingoProvider, tiingoSymbols } from "../../../src/engine/markets/providers/tiingo";
import { ProviderError } from "../../../src/engine/markets/providers/types";
import { tempHome } from "../../helpers";
import { fixture, jsonResponse, stubFetch } from "./fakes";

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

const TOKEN = "CANARYtiingo1";
const NOW = Date.parse("2026-11-04T22:00:00Z");
const make = (f: typeof fetch) =>
  tiingoProvider(TOKEN, {
    fetch: f,
    now: () => NOW,
    budget: { day: dailyBudget(db, "tiingo", 950, () => NOW), hour: hourlyBudget(db, "tiingo", 48, () => NOW) },
    symbols: tiingoSymbols(db, () => NOW),
  });
const SPY = { symbol: "SPY", exchange: "US" as const };
const err = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as ProviderError;
  }
  throw new Error("expected a failure");
};

test("the token goes in the header, never the URL, and rows map to bars and dividends", async () => {
  const s = stubFetch(() => jsonResponse(fixture("investing/tiingo-spy.json")));
  const t = make(s.fetch);
  const rows = await t.daily(SPY, "2026-10-20");
  expect(s.calls[0]!.headers.authorization).toBe(`Token ${TOKEN}`);
  expect(s.calls[0]!.url.href).not.toContain(TOKEN);
  expect(s.calls[0]!.url.href).toBe("https://api.tiingo.com/tiingo/daily/SPY/prices?startDate=2026-10-20");
  expect(rows).toHaveLength(10);
  expect(rows.at(-1)!.date).toBe("2026-11-04");
  expect(rows.at(-1)!.bar.t).toBe(etInstant("2026-11-04", "00:00") / 1000);
  expect(rows.at(-1)!.bar.c).toBe(594.6);
  expect(rows.filter((r) => r.divCash > 0).map((r) => [r.date, r.divCash])).toEqual([["2026-10-27", 1.83]]);
  const q = await t.quotes([SPY]);
  expect(q).toEqual([{ key: "SPY", price: 594.6, prevClose: 595.4, at: etInstant("2026-11-04", "16:00"), source: "tiingo", freshness: "eod" }]);
  expect(t.id).toBe("tiingo");
  expect(t.covers(SPY)).toBe(true);
  expect(t.covers({ symbol: "SHOP", exchange: "TSX" })).toBe(false);
  expect((await err(t.bars(SPY, "5Min", NOW - 86_400_000, NOW))).kind).toBe("no_history");
});

test("a rejected token is an auth error that doesn't echo it", async () => {
  const s = stubFetch(() => new Response(`{"detail":"Invalid token ${TOKEN}"}`, { status: 401 }));
  const e = await err(make(s.fetch).daily(SPY, "2026-10-20"));
  expect(e.kind).toBe("auth");
  expect(e.message).toBe("Tiingo rejected the token. Check it in Settings → Market data.");
  expect(e.message).not.toContain(TOKEN);
});

test("Atrium stops at 950 requests a day", async () => {
  db.query("INSERT INTO settings (key, value) VALUES ('markets.budget.tiingo.2026-11-04', '948')").run();
  const s = stubFetch(() => jsonResponse(fixture("investing/tiingo-spy.json")));
  const t = make(s.fetch);
  await t.daily(SPY, "2026-10-20");
  await t.daily(SPY, "2026-10-20");
  const e = await err(t.daily(SPY, "2026-10-20"));
  expect(e.kind).toBe("rate_limited");
  expect(e.message).toBe("Tiingo's free daily or hourly limit is reached; closes refresh later.");
  expect(s.calls).toHaveLength(2);
});

test("Atrium stops at 450 symbols a month", async () => {
  const taken = Array.from({ length: 450 }, (_, i) => `S${i}`);
  db.query("INSERT INTO settings (key, value) VALUES ('markets.tiingo.symbols.2026-11', ?)").run(JSON.stringify(taken));
  const s = stubFetch(() => jsonResponse(fixture("investing/tiingo-spy.json")));
  const t = make(s.fetch);
  const e = await err(t.daily(SPY, "2026-10-20"));
  expect(e.kind).toBe("rate_limited");
  expect(e.message).toBe("Tiingo's free plan allows 500 symbols a month; Atrium stops at 450.");
  expect(s.calls).toHaveLength(0);
  await t.daily({ symbol: "S7", exchange: "US" }, "2026-10-20");
  expect(s.calls).toHaveLength(1);
});
