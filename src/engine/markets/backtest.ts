import { rsi, sma } from "./indicators";
import type { Bar } from "./providers/types";

export type BacktestTemplate =
  | { kind: "sma_cross"; fast: number; slow: number }
  | { kind: "rsi_revert"; period: number; buyBelow: number; sellAbove: number }
  | { kind: "buy_hold" };

export type BacktestResult = {
  trades: { t: number; side: "buy" | "sell"; price: number; qty: number }[];
  endEquity: number;
  returnPct: number;
  maxDrawdownPct: number;
  buyHoldReturnPct: number;
  bars: number;
};

export function describeTemplate(t: BacktestTemplate): string {
  if (t.kind === "sma_cross") return `SMA ${t.fast}/${t.slow} crossover`;
  if (t.kind === "rsi_revert") return `RSI(${t.period}) buy below ${t.buyBelow}, sell above ${t.sellAbove}`;
  return "Buy and hold";
}

// What the template wants to hold after bar i's close: true = in, false = out, null = no change.
function signals(bars: Bar[], t: BacktestTemplate): (boolean | null)[] {
  const closes = bars.map((b) => b.c);
  if (t.kind === "buy_hold") return bars.map((_, i) => (i === 0 ? true : null));
  if (t.kind === "sma_cross") {
    const fast = sma(closes, t.fast);
    const slow = sma(closes, t.slow);
    return bars.map((_, i) => {
      const [f0, s0, f1, s1] = [fast[i - 1], slow[i - 1], fast[i], slow[i]];
      if (i === 0 || f0 == null || s0 == null || f1 == null || s1 == null) return null;
      if (f0 <= s0 && f1 > s1) return true;
      if (f0 >= s0 && f1 < s1) return false;
      return null;
    });
  }
  const r = rsi(closes, t.period);
  return r.map((v) => (v === null ? null : v < t.buyBelow ? true : v > t.sellAbove ? false : null));
}

// No lookahead: a signal on bar i's close fills at bar i+1's open (buy-and-hold buys bar 0's open). All in or all
// out, fractional shares, no costs. An open position is valued at the last close.
export function backtest(bars: Bar[], t: BacktestTemplate, startingCash = 10_000): BacktestResult {
  const trades: BacktestResult["trades"] = [];
  const first = bars[0];
  const last = bars.at(-1);
  const buyHoldReturnPct = first && last ? (last.c / first.o - 1) * 100 : 0;
  let cash = startingCash;
  let qty = 0;
  let peak = startingCash;
  let maxDrawdownPct = 0;
  const want = signals(bars, t);
  const fill = (i: number, side: "buy" | "sell") => {
    const price = bars[i]!.o;
    if (side === "buy") {
      qty = cash / price;
      cash = 0;
    } else {
      cash = qty * price;
    }
    trades.push({ t: bars[i]!.t, side, price, qty: side === "buy" ? qty : trades.at(-1)!.qty });
    if (side === "sell") qty = 0;
  };
  for (let i = 0; i < bars.length; i++) {
    if (t.kind === "buy_hold" && i === 0) fill(0, "buy");
    else if (i > 0) {
      const w = want[i - 1];
      if (w === true && qty === 0) fill(i, "buy");
      else if (w === false && qty > 0) fill(i, "sell");
    }
    const equity = cash + qty * bars[i]!.c;
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - equity) / peak) * 100);
  }
  const endEquity = cash + qty * (last?.c ?? 0);
  return { trades, endEquity, returnPct: (endEquity / startingCash - 1) * 100, maxDrawdownPct, buyHoldReturnPct, bars: bars.length };
}
