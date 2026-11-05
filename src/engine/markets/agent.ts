import type { Database } from "bun:sqlite";
import { createApproval } from "../approvals";
import type { Space } from "../spaces";
import type { Task } from "../tasks";
import { agentName } from "../text";
import { backtest, describeTemplate, type BacktestTemplate } from "./backtest";
import { cachedBars, cachedQuotes } from "./cache";
import { etClock, etDate, etInstant, usSession } from "./calendar";
import type { ChartRange, MarketData } from "./data";
import { listHoldings } from "./holdings";
import { rsi, sma } from "./indicators";
import { instrumentKey, parseInstrumentKey, type Instrument } from "./instrument";
import { currencyOfKey, freshnessText, money } from "./labels";
import { paperState, placePaperOrder } from "./paper";
import type { Quote } from "./providers/types";
import { redact } from "./redact";
import { describeLimits, getStrategy, markStrategyRun, proposeStrategy, type StrategyInput } from "./strategies";
import { listWatchlist } from "./watchlist";

export type MarketsBlock = {
  orders?: { symbol: string; side: "buy" | "sell"; qty: number; reason: string }[];
  flags?: { symbol: string; note: string }[];
  backtests?: { symbol: string; template: BacktestTemplate; range?: ChartRange }[];
  strategies?: StrategyInput[];
};

export type MarketsHooks = {
  context(task: Task, space: Space, agent: string): Promise<string>;
  settle(task: Task, space: Space, agent: string, summary: string): Promise<{ done: boolean; lines: string[]; activity?: string }>;
};

export const MARKETS_SYSTEM_LINES = [
  "This is a markets space. Atrium never places real trades and you can't either.",
  "Paper orders only run for an approved paper strategy, written in a fenced atrium-markets JSON block as described in the task.",
  "End with: Analysis, not advice.",
];

const LIMITS = { orders: 5, flags: 3, backtests: 3, strategies: 1 };
const CONTEXT_MAX_BYTES = 12 * 1024;
const NEWS_MAX = 15;
const RANGES: ChartRange[] = ["5D", "1M", "3M", "6M", "1Y"];

// The last ```atrium-markets fence wins, so an agent that drafts and then corrects itself is read by its final word.
export function parseMarketsBlock(summary: string): MarketsBlock | null {
  const blocks = [...summary.matchAll(/```atrium-markets[^\n]*\n([\s\S]*?)```/g)];
  const last = blocks.at(-1);
  if (!last) return null;
  try {
    const v = JSON.parse(last[1]!) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as MarketsBlock) : null;
  } catch {
    return null;
  }
}

const pct = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}%`;
const fmt = (n: number | null | undefined, d = 2) => (n == null ? "n/a" : n.toFixed(d));

const BLOCK_HELP = [
  "To act, end your reply with one fenced block whose info string is atrium-markets, holding JSON like:",
  "```atrium-markets",
  '{"orders":[{"symbol":"AAPL","side":"buy","qty":5,"reason":"Closed above SMA20 on rising volume"}],',
  ' "flags":[{"symbol":"MSFT","note":"RSI under 30 after earnings"}],',
  ' "backtests":[{"symbol":"AAPL","template":{"kind":"sma_cross","fast":20,"slow":50},"range":"1Y"}],',
  ' "strategies":[{"name":"Momentum","rules":"…","symbols":["AAPL"],"cadence":"open","maxPositionValue":2000,"maxTradesPerDay":3}]}',
  "```",
  'Backtest templates: {"kind":"sma_cross","fast":n,"slow":n}, {"kind":"rsi_revert","period":14,"buyBelow":30,"sellAbove":70}, {"kind":"buy_hold"}. Ranges: 1M, 3M, 6M, 1Y. Cadence: open (9:45 AM ET), hourly, close (3:45 PM ET).',
  `Limits per run: at most ${LIMITS.orders} orders, ${LIMITS.flags} flags, ${LIMITS.backtests} backtests and ${LIMITS.strategies} strategy. Orders are ignored unless this task runs an approved paper strategy. A strategy you propose waits for Nakul's approval.`,
];

export function createMarketsHooks(db: Database, deps: { data: MarketData; now?: () => number }): MarketsHooks {
  const { data } = deps;
  const now = deps.now ?? Date.now;
  const reason = (e: unknown) => redact(e instanceof Error ? e.message : String(e), data.secrets());

  const tradesToday = (strategyId: string, at: number) =>
    (
      db.query("SELECT COUNT(*) AS n FROM paper_fills WHERE strategy_id = ? AND created_at >= ?").get(strategyId, etInstant(etDate(at), "00:00")) as {
        n: number;
      }
    ).n;

  async function buildContext(task: Task, space: Space, agent: string): Promise<string> {
    const at = now();
    const session = usSession(at);
    const status = await data.status();
    const watch = listWatchlist(db, space.id);
    const holdings = listHoldings(db, space.id);
    const strategy = task.strategyId ? getStrategy(db, task.strategyId) : null;
    // Holdings tickers are account data too: only Claude's prompt includes them, even in its price and news lines.
    const own = agent === "claude" ? holdings : [];
    const instruments = new Map<string, Instrument>();
    for (const i of [...watch, ...own]) instruments.set(instrumentKey(i), { symbol: i.symbol, exchange: i.exchange });
    for (const k of strategy?.symbols ?? []) {
      const i = parseInstrumentKey(k);
      if (i) instruments.set(k, i);
    }
    // A fresh look at live-priced symbols; end-of-day ones come from the cache so the Alpha Vantage budget lasts.
    const live = [...instruments.values()].filter((i) => {
      const p = data.providerFor(i);
      return p !== null && p.id !== "alphavantage";
    });
    if (live.length && session.open) await data.quotes(live).catch(() => null);
    const quotes = cachedQuotes(db, [...instruments.keys()]);
    const line = (key: string, q: Quote | undefined) =>
      q ? `${key} ${money(q.price, currencyOfKey(key))}${q.prevClose ? ` ${pct((q.price / q.prevClose - 1) * 100)} today` : ""} (${freshnessText(q)}, ${etClock(q.at)})` : `${key}: no price yet`;

    const out: string[] = [];
    out.push(`Market data as of ${etClock(at)} on ${etDate(at)}. US market ${session.open ? "open" : session.holiday ? `closed (${session.holiday})` : "closed"}.`);
    out.push(`Sources: US ${status.us.message}; Canada ${status.ca.message}. Prices you see are all Atrium has; no other source is available to you.`);
    if (watch.length) out.push("Watchlist:", ...watch.map((w) => `- ${line(w.key, quotes.get(w.key))}`));
    const ind: string[] = [];
    for (const key of instruments.keys()) {
      const closes = cachedBars(db, key, "1Day", 0).map((b) => b.c);
      if (closes.length < 20) continue;
      ind.push(`- ${key}: SMA20 ${fmt(sma(closes, 20).at(-1))}, SMA50 ${fmt(sma(closes, 50).at(-1))}, RSI14 ${fmt(rsi(closes, 14).at(-1), 1)} (daily closes)`);
    }
    if (ind.length) out.push("Indicators:", ...ind);
    try {
      const news = (await data.news([...instruments.values()], at - 86_400_000)).slice(0, NEWS_MAX);
      if (news.length) out.push("News (last 24 hours):", ...news.map((n) => `- ${n.key}: ${n.headline} (${n.source}, ${etClock(n.at)})`));
    } catch (e) {
      out.push(`News unavailable: ${reason(e)}`);
    }
    // Account details are Nakul's private data: only Claude, which private spaces are limited to, ever sees them.
    if (agent === "claude") {
      if (holdings.length) {
        out.push("Holdings:");
        for (const h of holdings) {
          const q = quotes.get(h.key);
          const book = h.bookValue === null ? "book value unknown" : `book value ${money(h.bookValue, h.currency)}`;
          out.push(`- ${h.account}: ${h.key} × ${h.quantity}, ${book}, ${q ? line(h.key, q) : "no price yet"}`);
        }
      }
      const p = paperState(db, space.id, quotes, at);
      out.push(
        `Paper account: cash ${money(p.cash, "USD")}, equity ${money(p.equity, "USD")}, today ${money(p.dayPnl, "USD")}, total ${money(p.totalPnl, "USD")}.`,
        ...p.positions.map((x) => `- ${x.symbol} × ${x.qty} @ avg ${money(x.avgCost, "USD")}${x.last === null ? "" : `, last ${money(x.last, "USD")}`}`),
      );
    }
    if (strategy) {
      out.push(`This task runs the approved paper strategy "${strategy.name}" (${strategy.status}).`, `Rules: ${strategy.rules}`, describeLimits(strategy));
      out.push(`Trades used today: ${tradesToday(strategy.id, at)} of ${strategy.maxTradesPerDay}.`);
      for (const k of strategy.symbols) {
        const bars = cachedBars(db, k, "1Day", Math.floor((at - 366 * 86_400_000) / 1000));
        if (bars.length < 51) continue;
        const r = backtest(bars, { kind: "sma_cross", fast: 20, slow: 50 });
        out.push(`Backtest ${k} SMA 20/50 crossover (cached year): ${r.returnPct.toFixed(1)}% vs buy-and-hold ${r.buyHoldReturnPct.toFixed(1)}%.`);
      }
    }
    out.push(...BLOCK_HELP);
    let text = out.join("\n");
    if (Buffer.byteLength(text) > CONTEXT_MAX_BYTES) text = `${Buffer.from(text).subarray(0, CONTEXT_MAX_BYTES - 40).toString()}\n[market context cut to fit]`;
    return text;
  }

  return {
    async context(task, space, agent) {
      try {
        return await buildContext(task, space, agent);
      } catch (e) {
        return `Market data unavailable: ${reason(e)}`;
      }
    },
    async settle(task, space, agent, summary) {
      const block = parseMarketsBlock(summary);
      const lines: string[] = [];
      const at = now();
      const strategy = task.strategyId ? getStrategy(db, task.strategyId) : null;
      let filled = 0;
      let refused = 0;
      const orders = Array.isArray(block?.orders) ? block!.orders : [];
      if (orders.length && strategy?.status === "active") {
        for (const o of orders.slice(0, LIMITS.orders)) {
          const inst = typeof o?.symbol === "string" ? parseInstrumentKey(o.symbol) : null;
          const key = inst ? instrumentKey(inst) : String(o?.symbol ?? "?");
          const side = o?.side === "sell" ? "sell" : "buy";
          const qty = Number(o?.qty);
          const label = `${side} ${o?.qty} ${key}`;
          const refuse = (why: string) => {
            refused++;
            lines.push(`Refused: ${label} — ${why}`);
          };
          if (o?.side !== "buy" && o?.side !== "sell") {
            refuse("an order's side must be buy or sell.");
            continue;
          }
          if (!strategy.symbols.includes(key)) {
            refuse(`${key} isn't one of this strategy's symbols.`);
            continue;
          }
          if (tradesToday(strategy.id, at) >= strategy.maxTradesPerDay) {
            refuse(`this strategy already made its ${strategy.maxTradesPerDay} trades today.`);
            continue;
          }
          const quote = cachedQuotes(db, [key]).get(key) ?? null;
          if (side === "buy" && quote) {
            const held = paperState(db, space.id, new Map(), at).positions.find((p) => p.symbol === key)?.qty ?? 0;
            const value = (held + qty) * quote.price;
            if (value > strategy.maxPositionValue) {
              refuse(`that would put ${money(value, "USD")} in ${key}; this strategy's limit is ${money(strategy.maxPositionValue, "USD")}.`);
              continue;
            }
          }
          const r = placePaperOrder(
            db,
            { spaceId: space.id, symbol: key, side, qty, reasoning: String(o?.reason ?? ""), actor: agent, strategyId: strategy.id, taskId: task.id },
            quote,
            at,
          );
          if (r.ok) {
            filled++;
            lines.push(`Filled: ${side} ${r.fill.qty} ${key} @ ${money(r.fill.price, "USD")} — ${r.fill.reasoning}`);
          } else refuse(r.reason);
        }
      } else if (orders.length) {
        lines.push(`Paper orders only run from an approved strategy; ignored ${orders.length}.`);
      }
      for (const f of (Array.isArray(block?.flags) ? block!.flags : []).slice(0, LIMITS.flags)) {
        const inst = typeof f?.symbol === "string" ? parseInstrumentKey(f.symbol) : null;
        if (!inst || typeof f?.note !== "string") continue;
        const key = instrumentKey(inst);
        createApproval(db, { spaceId: space.id, kind: "alert", title: `${agentName(agent)} flagged ${key}`, detail: `${f.note.trim()}\n\nAnalysis, not advice.` });
        lines.push(`Flagged ${key}: ${f.note.trim()}`);
      }
      for (const b of (Array.isArray(block?.backtests) ? block!.backtests : []).slice(0, LIMITS.backtests)) {
        const inst = typeof b?.symbol === "string" ? parseInstrumentKey(b.symbol) : null;
        const range: ChartRange = b?.range && RANGES.includes(b.range) && b.range !== "5D" ? b.range : "1Y";
        if (!inst || !b?.template) continue;
        const key = instrumentKey(inst);
        try {
          const res = await data.bars(inst, range);
          const r = backtest(res.bars, b.template);
          lines.push(
            `Backtest ${key} ${describeTemplate(b.template)} (${range}): ${r.returnPct.toFixed(1)}% vs buy-and-hold ${r.buyHoldReturnPct.toFixed(1)}%, max drawdown ${r.maxDrawdownPct.toFixed(1)}%, ${r.trades.length} trades.`,
          );
        } catch (e) {
          lines.push(`Backtest ${key} couldn't run: ${reason(e)}`);
        }
      }
      for (const s of (Array.isArray(block?.strategies) ? block!.strategies : []).slice(0, LIMITS.strategies)) {
        try {
          const p = proposeStrategy(db, space.id, s, agent);
          lines.push(`Proposed paper strategy "${p.name}"; it's in Needs you.`);
        } catch (e) {
          lines.push(`Couldn't propose that strategy: ${reason(e)}`);
        }
      }
      if (strategy) {
        markStrategyRun(db, strategy.id, at);
        return { done: true, lines, activity: `Paper strategy run: ${filled} filled, ${refused} refused` };
      }
      return { done: false, lines };
    },
  };
}
