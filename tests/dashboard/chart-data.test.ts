import { expect, test } from "bun:test";
import { chartSeries } from "../../src/dashboard/chart-data";
import { etInstant } from "../../src/engine/markets/calendar";
import type { Bar } from "../../src/engine/markets/providers/types";

const days = (n: number): Bar[] =>
  Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(2026, 0, 2) + i * 86_400_000).toISOString().slice(0, 10);
    const c = 100 + Math.sin(i) * 5;
    return { t: etInstant(d, "00:00") / 1000, o: i % 2 ? c - 1 : c + 1, h: c + 2, l: c - 2, c, v: 1000 + i };
  });

const all = { sma20: true, sma50: true, ema20: true, rsi14: true };

test("daily bars map to ET date strings with indicator lines", () => {
  const s = chartSeries(days(60), "1Day", all);
  expect(s.candles).toHaveLength(60);
  expect(s.candles[0]!.time).toBe("2026-01-02");
  expect(typeof s.candles[59]!.time).toBe("string");
  expect(s.lines.sma50).toHaveLength(11);
  expect(s.lines.sma20).toHaveLength(41);
  expect(s.lines.ema20).toHaveLength(41);
  const times = s.candles.map((c) => String(c.time));
  expect([...times].sort()).toEqual(times);
  expect(new Set(times).size).toBe(60);
  expect(s.rsi).toHaveLength(46);
  for (const p of [...s.lines.sma50, ...s.rsi]) expect(p.value).not.toBeNull();
});

test("5Min bars use numeric times and volume colours follow the candle", () => {
  const bars: Bar[] = [
    { t: 1_793_889_000, o: 10, h: 11, l: 9, c: 10.5, v: 5 },
    { t: 1_793_889_300, o: 10.5, h: 11, l: 9, c: 10, v: 6 },
  ];
  const s = chartSeries(bars, "5Min", { sma20: false, sma50: false, ema20: false, rsi14: false });
  expect(s.candles.map((c) => c.time as number)).toEqual([1_793_889_000, 1_793_889_300]);
  expect(s.volume[0]!.color).not.toBe(s.volume[1]!.color);
  expect(s.rsi).toEqual([]);
  expect(s.lines.sma20).toEqual([]);
});
