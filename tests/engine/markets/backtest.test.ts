import { expect, test } from "bun:test";
import { backtest, describeTemplate } from "../../../src/engine/markets/backtest";
import type { Bar } from "../../../src/engine/markets/providers/types";

const bars = (closes: number[]): Bar[] => closes.map((c, i) => ({ t: 1_700_000_000 + i * 86_400, o: c - 0.5, h: c + 1, l: c - 1, c, v: 100 }));

test("SMA cross signals on a close and fills at the next open", () => {
  const b = bars([10, 9, 8, 7, 6, 9, 10, 11]);
  const r = backtest(b, { kind: "sma_cross", fast: 2, slow: 3 });
  expect(r.trades[0]).toMatchObject({ t: b[6]!.t, side: "buy", price: b[6]!.o });
  expect(r.trades[0]!.qty).toBeCloseTo(10_000 / b[6]!.o, 6);
  expect(r.endEquity).toBeCloseTo(r.trades[0]!.qty * 11, 6);
  expect(r.bars).toBe(8);
});

test("too few bars means no trades", () => {
  const r = backtest(bars([10, 11]), { kind: "sma_cross", fast: 20, slow: 50 });
  expect(r.trades).toEqual([]);
  expect(r.returnPct).toBe(0);
  expect(r.endEquity).toBe(10_000);
});

test("buy and hold return and drawdown", () => {
  const b: Bar[] = [100, 120, 90, 130].map((c, i) => ({ t: i, o: i === 0 ? 100 : c, h: c, l: c, c, v: 1 }));
  const r = backtest(b, { kind: "buy_hold" });
  expect(r.returnPct).toBeCloseTo((130 / 100 - 1) * 100, 6);
  expect(r.buyHoldReturnPct).toBeCloseTo(30, 6);
  expect(r.maxDrawdownPct).toBeCloseTo(25, 6);
  expect(r.trades).toHaveLength(1);
});

test("rsi reversion buys low and sells high", () => {
  const closes = [...Array.from({ length: 16 }, (_, i) => 100 - i * 2), ...Array.from({ length: 16 }, (_, i) => 70 + i * 3)];
  const r = backtest(bars(closes), { kind: "rsi_revert", period: 14, buyBelow: 30, sellAbove: 70 });
  expect(r.trades[0]!.side).toBe("buy");
  expect(r.trades.some((t) => t.side === "sell")).toBe(true);
});

test("describeTemplate", () => {
  expect(describeTemplate({ kind: "sma_cross", fast: 20, slow: 50 })).toBe("SMA 20/50 crossover");
  expect(describeTemplate({ kind: "rsi_revert", period: 14, buyBelow: 30, sellAbove: 70 })).toBe("RSI(14) buy below 30, sell above 70");
  expect(describeTemplate({ kind: "buy_hold" })).toBe("Buy and hold");
});
