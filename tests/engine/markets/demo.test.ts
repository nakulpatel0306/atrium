import { expect, test } from "bun:test";
import { etDate, usHolidays } from "../../../src/engine/markets/calendar";
import { demoProvider } from "../../../src/engine/markets/providers/demo";

const IN_SESSION = Date.parse("2026-11-05T16:00:00Z"); // 11:00 ET, Thursday
const AAPL = { symbol: "AAPL", exchange: "US" as const };
const SHOP = { symbol: "SHOP", exchange: "TSX" as const };

test("deterministic per key and clock, different across keys", async () => {
  const a = demoProvider({ now: () => IN_SESSION });
  const b = demoProvider({ now: () => IN_SESSION });
  const from = Date.parse("2026-10-01T00:00:00Z");
  expect(await a.bars(AAPL, "1Day", from, IN_SESSION)).toEqual(await b.bars(AAPL, "1Day", from, IN_SESSION));
  expect(await a.quotes([AAPL])).toEqual(await b.quotes([AAPL]));
  const [qa] = await a.quotes([AAPL]);
  const [qs] = await a.quotes([SHOP]);
  expect(qa!.price).not.toBe(qs!.price);
  expect(qa!.freshness).toBe("demo");
  expect(qs!.key).toBe("SHOP.TO");
  expect(a.covers({ symbol: "AAPL", exchange: "NEO" })).toBe(true);
});

test("daily bars skip weekends and holidays and are well formed", async () => {
  const p = demoProvider({ now: () => IN_SESSION });
  const bars = await p.bars(AAPL, "1Day", Date.parse("2026-10-01T04:00:00Z"), IN_SESSION);
  const holidays = new Set(usHolidays(2026).map((h) => h.date));
  expect(bars.length).toBeGreaterThan(20);
  for (const b of bars) {
    const d = etDate(b.t * 1000 + 3_600_000);
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
    expect(dow === 0 || dow === 6).toBe(false);
    expect(holidays.has(d)).toBe(false);
    expect(b.l).toBeLessThanOrEqual(Math.min(b.o, b.c));
    expect(Math.max(b.o, b.c)).toBeLessThanOrEqual(b.h);
    expect(b.v).toBeGreaterThan(0);
  }
  // Today's session isn't finished, so the last bar is yesterday's.
  expect(etDate(bars.at(-1)!.t * 1000 + 3_600_000)).toBe("2026-11-04");
  expect(bars[0]!.t).toBe(Date.parse("2026-10-01T04:00:00Z") / 1000);
});

test("prevClose is the last completed daily bar's close", async () => {
  const p = demoProvider({ now: () => IN_SESSION });
  const bars = await p.bars(AAPL, "1Day", IN_SESSION - 10 * 86_400_000, IN_SESSION);
  const [q] = await p.quotes([AAPL]);
  expect(q!.prevClose).toBe(bars.at(-1)!.c);
  expect(q!.at).toBe(IN_SESSION);
});

test("5Min bars cover the session so far", async () => {
  const p = demoProvider({ now: () => IN_SESSION });
  const bars = await p.bars(AAPL, "5Min", Date.parse("2026-11-05T05:00:00Z"), IN_SESSION);
  expect(bars.length).toBe(18); // 09:30 → 11:00
  expect(bars[0]!.t).toBe(Date.parse("2026-11-05T14:30:00Z") / 1000);
});

test("the stream emits during the session and stops after close", async () => {
  const p = demoProvider({ now: () => IN_SESSION, tickMs: 20 });
  const seen: string[] = [];
  const s = p.stream!([AAPL], { quote: (q) => seen.push(q.key), status: () => {} });
  await Bun.sleep(70);
  s.close();
  const n = seen.length;
  expect(n).toBeGreaterThanOrEqual(2);
  await Bun.sleep(60);
  expect(seen.length).toBe(n);
  await p.validate();
});

test("the stream is quiet outside the session", async () => {
  const p = demoProvider({ now: () => Date.parse("2026-11-07T16:00:00Z"), tickMs: 10 });
  const seen: string[] = [];
  const s = p.stream!([AAPL], { quote: (q) => seen.push(q.key), status: () => {} });
  await Bun.sleep(40);
  s.close();
  expect(seen).toEqual([]);
});

test("demo earnings, metrics and profiles are deterministic", async () => {
  const p = demoProvider({ now: () => IN_SESSION });
  const list = [AAPL, { symbol: "MSFT", exchange: "US" as const }];
  const a = await p.earnings!(list, "2026-11-05", "2026-12-05");
  expect(a).toEqual(await demoProvider({ now: () => IN_SESSION }).earnings!(list, "2026-11-05", "2026-12-05"));
  // Thu Nov 5 + 3 trading days = Tue Nov 10.
  expect(a.find((e) => e.key === "AAPL")).toEqual({ key: "AAPL", date: "2026-11-10", hour: "amc", epsEstimate: expect.any(Number) });
  for (const e of a) expect(e.date >= "2026-11-05" && e.date <= "2026-12-05").toBe(true);
  const m = await p.metric!(AAPL);
  expect(m).toEqual(await p.metric!(AAPL));
  expect(m.pe).toBeGreaterThan(0);
  expect(m.high52!).toBeGreaterThan(m.low52!);
  expect((await p.profile!(AAPL))!.name).toContain("AAPL");
});
