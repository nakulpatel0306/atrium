import { expect, test } from "bun:test";
import { ema, rsi, sma } from "../../../src/engine/markets/indicators";

const close = (a: (number | null)[], b: (number | null)[]) => {
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => (b[i] === null ? expect(v).toBeNull() : expect(v!).toBeCloseTo(b[i]!, 4)));
};

test("sma and ema", () => {
  close(sma([2, 4, 6, 8, 12], 3), [null, null, 4, 6, 8.6667]);
  close(ema([2, 4, 6, 8, 12], 3), [null, null, 4, 6, 9]);
  expect(sma([1, 2], 3)).toEqual([null, null]);
});

test("rsi uses Wilder smoothing", () => {
  const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28];
  const r = rsi(closes);
  for (let i = 0; i < 14; i++) expect(r[i]).toBeNull();
  expect(r[14]!).toBeCloseTo(70.46, 1);
  expect(rsi(Array.from({ length: 20 }, (_, i) => i + 1)).at(-1)).toBe(100);
  expect(rsi(Array.from({ length: 20 }, () => 5)).at(-1)).toBe(50);
});
