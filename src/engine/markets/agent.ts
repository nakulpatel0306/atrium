import type { Database } from "bun:sqlite";
import { maskNumbers } from "../money/import";
import { explainContext, moneyFacts } from "../money/summary";
import { isAdvanced } from "./advanced";
import { portfolioView } from "./views";
import { createApproval } from "../approvals";
import type { Space } from "../spaces";
import type { Task } from "../tasks";
import { agentName } from "../text";
import { backtest, describeTemplate, type BacktestTemplate } from "./backtest";
import { cachedBars, cachedQuotes } from "./cache";
import { etClock, etDate, etInstant, lastCompletedSession, usSession } from "./calendar";
import { currentQuote, type ChartRange, type MarketData } from "./data";
import { listHoldings } from "./holdings";
import { rsi, sma } from "./indicators";
import { instrumentKey, parseInstrumentKey, type Instrument } from "./instrument";
import { currencyOfKey, freshnessText, money } from "./labels";
import { paperState, placePaperOrder } from "./paper";
import type { Quote } from "./providers/types";
import { redact } from "./redact";
import { describeLimits, getStrategy, markStrategyRun, proposeStrategy, type StrategyInput } from "./strategies";
import { recentNews, saveNews, upcomingEarnings } from "./events";
import { getMeta } from "./meta";
import { healthFor } from "./portfolio";
import { getNotes, latestWriteups, saveWriteup } from "./research";
import { listWatchlist } from "./watchlist";

const DAY_LABEL = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
// "Fri, Nov 6" for an ET session date.
const dayLabel = (iso: string) => DAY_LABEL.format(Date.parse(`${iso}T12:00:00Z`));
// A move is "today" only while today's session is open; otherwise it's named by the session it happened in, so a
// weekend digest doesn't call Friday's move today's.
const dayOf = (quoteAt: number, at: number, open: boolean) => (open && etDate(quoteAt) === etDate(at) ? "today" : `on ${dayLabel(etDate(quoteAt))}`);

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
  `Limits per run: at most ${LIMITS.orders} orders, ${LIMITS.flags} flags, ${LIMITS.backtests} backtests and ${LIMITS.strategies} strategy. Orders are ignored unless this task runs an approved paper strategy. A strategy you propose waits for the user's approval.`,
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

  function investingContext(task: Task, space: Space, at: number): string[] {
    const out: string[] = [];
    const h = healthFor(db, data, space.id, at);
    if (h.totalCad) {
      const top = h.byCompany.filter((c) => c.key).slice(0, 5).map((c) => `${c.label} ${c.pct.toFixed(1)}%`);
      out.push(`Portfolio: ${money(h.totalCad.value, "CAD")} (${h.totalCad.source}). Top exposures: ${top.join(", ")}.`);
      if (h.warnings.length) out.push("Portfolio warnings:", ...h.warnings.map((w) => `- ${w.text}`));
    }
    if (task.purpose === "digest") {
      const keys = [...new Set(listHoldings(db, space.id).map((x) => x.key).concat(listWatchlist(db, space.id).map((w) => w.key)))];
      const last = latestWriteups(db, space.id, { kind: "digest", limit: 1 })[0];
      const since = Math.max(last?.createdAt ?? 0, at - 3 * 86_400_000);
      const news = recentNews(db, keys, since, 25);
      if (news.length) out.push("News since the last digest:", ...news.map((n) => `- ${n.key}: ${n.headline} (${n.source}, ${etClock(n.at)})`));
      const when = usSession(at).open ? "today" : `on ${dayLabel(lastCompletedSession(at).date)}`;
      out.push(
        isAdvanced(db, space.id)
          ? `Write a short digest for the user: what moved in their portfolio ${when} and why, from these prices and headlines. Say which numbers are delayed.`
          : `Write at most 4 short sentences for the user: what moved in their portfolio ${when} and why, from these prices and headlines. Say which numbers are delayed. No headings.`,
      );
    }
    if (task.purpose === "money") {
      out.push(...moneyFacts(db, space.id, at));
      if (task.detail.trim()) out.push(`The user asks: ${task.detail.trim()}`);
      out.push(
        "Answer in at most 250 words of plain, everyday markdown, using only these facts and the portfolio above. Say plainly when they don't cover the question. Don't recommend specific investments.",
      );
    }
    if (task.purpose === "ask" && task.subject) {
      out.push(...subjectFacts(task.subject, at, true, space.id).slice(0, -1));
      const held = positionLine(space.id, task.subject, at);
      if (held) out.push(held);
      if (task.detail.trim()) out.push(`The user asks: ${task.detail.trim()}`);
      out.push("Answer in at most 200 words of plain markdown: what the company or fund does, what moved it lately and why, and what to watch next. Don't recommend buying or selling.");
    }
    if (task.purpose === "thesis_draft" || task.purpose === "thesis_check") out.push(...subjectFacts(task.subject, at, task.purpose === "thesis_check", space.id));
    return out;
  }

  // Two answers settled in the same millisecond still get their own row.
  function askInstant(spaceId: string, kind: string, key: string | null, at: number): string {
    const taken = db.query("SELECT 1 FROM market_writeups WHERE space_id = ? AND kind = ? AND key IS ? AND for_date = ?");
    let t = at;
    while (taken.get(spaceId, kind, key, new Date(t).toISOString())) t++;
    return new Date(t).toISOString();
  }

  function positionLine(spaceId: string, key: string, at: number): string | null {
    const held = listHoldings(db, spaceId).filter((h) => h.key === key);
    if (!held.length) return null;
    const qty = held.reduce((s, h) => s + h.quantity, 0);
    const accounts = [...new Set(held.map((h) => h.account))].join(" and ");
    const row = portfolioView(db, data, spaceId, at).holdings.find((h) => h.key === key);
    const worth = row?.valueCad != null && row.price ? `, worth ${money(row.valueCad, "CAD")} (${row.price.source})` : "";
    const gain = row?.gainCad != null ? `, gain ${row.gainCad >= 0 ? "+" : ""}${money(row.gainCad, "CAD")} since purchase` : "";
    return `The user holds ${qty} in ${accounts}${worth}${gain}.`;
  }

  // Public facts about one instrument, with their sources; Nakul's own thesis and notes only for a check.
  function subjectFacts(key: string | null, at: number, withNotes: boolean, spaceId?: string): string[] {
    if (!key) return [];
    const out = [`About ${key}:`];
    const m = getMeta(db, [key]).get(key);
    if (m) {
      const metrics = m.metricsAt ? ` (Finnhub · metrics ${etDate(m.metricsAt)})` : "";
      out.push(`- ${m.name ?? key}; sector ${m.sector ?? "unknown"}${m.sectorSource ? ` (${m.sectorSource})` : ""}; country ${m.country ?? "unknown"}.`);
      out.push(`- P/E ${fmt(m.pe)}, 52-week range ${fmt(m.low52)}–${fmt(m.high52)}, dividend yield ${m.divYield === null ? "n/a" : `${fmt(m.divYield)}%`}${metrics}.`);
    }
    const earnings = upcomingEarnings(db, [key], etDate(at), 60)[0];
    if (earnings) out.push(`- Next earnings ${earnings.date}${earnings.hour ? ` (${earnings.hour})` : ""}, EPS estimate ${fmt(earnings.epsEstimate)} (${earnings.source === "you" ? "entered by the user" : "Finnhub"}).`);
    const divs = db.query("SELECT ex_date, amount FROM market_dividends WHERE key = ? ORDER BY ex_date DESC LIMIT 4").all(key) as { ex_date: string; amount: number }[];
    if (divs.length) out.push(`- Dividends (Tiingo): ${divs.map((d) => `${d.ex_date} ${fmt(d.amount, 4)}`).join(", ")}.`);
    const news = recentNews(db, [key], 0, 10);
    if (news.length) out.push("- Latest headlines:", ...news.map((n) => `  - ${n.headline} (${n.source}, ${etDate(n.at)})`));
    if (withNotes && spaceId) {
      const n = getNotes(db, spaceId, key);
      out.push(`The user's thesis: ${n.thesis || "(none)"}`, `The user's notes: ${n.notes || "(none)"}`);
    }
    out.push("Write plain prose for the user. Do not recommend buying or selling.");
    return out;
  }

  async function buildContext(task: Task, space: Space, agent: string): Promise<string> {
    const at = now();
    // Money stays with Claude, masked; Explain my month gets the month's recap and nothing else.
    if (task.purpose === "money") {
      if (agent !== "claude") return "";
      const explain = explainContext(db, task, at);
      if (explain) return explain.join("\n");
      // A money question gets the portfolio summary and the money facts, not raw quotes, holdings or paper trades.
      return investingContext(task, space, at).join("\n");
    }
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
      q ? `${key} ${money(q.price, currencyOfKey(key))}${q.prevClose ? ` ${pct((q.price / q.prevClose - 1) * 100)} ${dayOf(q.at, at, session.open)}` : ""} (${freshnessText(q, at)}${q.source === "yahoo" ? "" : `, ${etClock(q.at)}`})` : `${key}: no price yet`;

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
      // Kept, so the investing context below (and the Symbol page's asks) read the same headlines.
      if (agent === "claude") saveNews(db, news, at);
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
    // Investing context: Claude only, since it's built on Nakul's holdings and notes.
    if (agent === "claude") out.push(...investingContext(task, space, at));
    else if (task.purpose === "thesis_draft" || task.purpose === "thesis_check" || task.purpose === "ask") out.push(...subjectFacts(task.subject, at, false));
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
            lines.push(`Refused: ${label} · ${why}`);
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
          const quote = inst ? currentQuote(db, data, inst) : null;
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
            lines.push(`Filled: ${side} ${r.fill.qty} ${key} @ ${money(r.fill.price, "USD")} · ${r.fill.reasoning}`);
          } else refuse(r.reason);
        }
      } else if (orders.length) {
        lines.push(`Paper orders only run from an approved strategy; ignored ${orders.length}.`);
      }
      for (const f of (Array.isArray(block?.flags) ? block!.flags : []).slice(0, LIMITS.flags)) {
        const inst = typeof f?.symbol === "string" ? parseInstrumentKey(f.symbol) : null;
        if (!inst || typeof f?.note !== "string") continue;
        const key = instrumentKey(inst);
        createApproval(db, { spaceId: space.id, kind: "alert", topic: "flag", subject: key, title: `${agentName(agent)} flagged ${key}`, detail: `${f.note.trim()}\n\nAnalysis, not advice.` });
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
      if (task.purpose) {
        // Money answers are masked again here, whatever the runner already did: nothing unmasked is ever saved.
        const said = task.purpose === "money" ? maskNumbers(summary) : summary;
        const body = said.replace(/```atrium-markets[^\n]*\n[\s\S]*?```/g, "").trim();
        // Every answer to an ask is kept, so it's dated to the instant rather than the day.
        const forDate =
          task.purpose === "ask" || task.purpose === "money"
            ? askInstant(space.id, task.purpose, task.subject, at)
            : task.purpose === "thesis_check"
              ? (task.title.match(/on (\d{4}-\d{2}-\d{2})$/)?.[1] ?? etDate(at))
              : etDate(at);
        saveWriteup(db, {
          spaceId: space.id,
          kind: task.purpose,
          key: task.subject,
          forDate,
          body: body.endsWith("Analysis, not advice.") ? body : `${body}\n\nAnalysis, not advice.`,
          taskId: task.id,
        });
        if (task.purpose === "ask" || task.purpose === "money") return { done: true, lines, activity: "Answer saved" };
        const what = task.purpose === "digest" ? "Digest" : task.purpose === "thesis_draft" ? "Thesis draft" : "Thesis check";
        return { done: true, lines, activity: `${what} saved` };
      }
      if (strategy) {
        markStrategyRun(db, strategy.id, at);
        return { done: true, lines, activity: `Paper strategy run: ${filled} filled, ${refused} refused` };
      }
      return { done: false, lines };
    },
  };
}
