import type { Time, UTCTimestamp } from "lightweight-charts";
import { ema, rsi, sma } from "../engine/markets/indicators";
import type { Bar, Timeframe } from "../engine/markets/providers/types";

export type Indicators = { sma20: boolean; sma50: boolean; ema20: boolean; rsi14: boolean };
type Point = { time: Time; value: number };

export const UP = "rgba(76, 183, 130, 0.45)";
export const DOWN = "rgba(235, 87, 87, 0.45)";

const etDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

// Daily bars are business days ("YYYY-MM-DD" in ET) so weekends leave no gaps; intraday bars are UTC seconds.
const timeOf = (b: Bar, tf: Timeframe): Time => (tf === "1Day" ? etDay.format(b.t * 1000 + 3_600_000) : (b.t as UTCTimestamp));

// The library rejects nulls, so warm-up points without a value are left out.
const line = (bars: Bar[], tf: Timeframe, values: (number | null)[]): Point[] =>
  values.flatMap((v, i) => (v === null ? [] : [{ time: timeOf(bars[i]!, tf), value: v }]));

export function chartSeries(bars: Bar[], timeframe: Timeframe, show: Indicators) {
  const closes = bars.map((b) => b.c);
  return {
    candles: bars.map((b) => ({ time: timeOf(b, timeframe), open: b.o, high: b.h, low: b.l, close: b.c })),
    volume: bars.map((b) => ({ time: timeOf(b, timeframe), value: b.v, color: b.c >= b.o ? UP : DOWN })),
    lines: {
      sma20: show.sma20 ? line(bars, timeframe, sma(closes, 20)) : [],
      sma50: show.sma50 ? line(bars, timeframe, sma(closes, 50)) : [],
      ema20: show.ema20 ? line(bars, timeframe, ema(closes, 20)) : [],
    },
    rsi: show.rsi14 ? line(bars, timeframe, rsi(closes, 14)) : [],
  };
}

// Where a live price lands: today's daily candle, or the 5-minute bucket it falls in.
export const liveTime = (at: number, tf: Timeframe): Time =>
  tf === "1Day" ? etDay.format(at) : ((Math.floor(at / 300_000) * 300) as UTCTimestamp);
