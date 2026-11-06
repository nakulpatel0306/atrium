import type { Database } from "bun:sqlite";
import { bus } from "../events";
import { createTask, listTasks, type Task } from "../tasks";
import { listAlerts, type Alert } from "./alerts";
import { cachedBars } from "./cache";
import { etDate, etInstant } from "./calendar";
import { currentQuote, type MarketData } from "./data";
import { estimateFor, ESTIMATED } from "./estimate";
import { recentNews, saveEarnings, saveNews, upcomingEarnings, type Earnings } from "./events";
import { isFund } from "./funds/sources";
import { listHoldings } from "./holdings";
import { instrumentKey, parseInstrumentKey, type Exchange } from "./instrument";
import { currencyOfKey } from "./labels";
import { listItems, listLists } from "./lists";
import { getMeta, saveMetrics, saveProfile } from "./meta";
import type { NewsItem } from "./providers/types";
import { ProviderError } from "./providers/types";
import { redact } from "./redact";
import { getNotes, latestWriteups, type Writeup } from "./research";
import { closeDayText, quoteSourced, type Sourced } from "./sourced";
import { tvSymbol, widgetCoverage } from "./tradingview";
import { portfolioView } from "./views";

export type SymbolView = {
  key: string;
  symbol: string;
  exchange: Exchange;
  name: string;
  // Funds have no company financials or stories, so the page shows TradingView's fundamentals and news for stocks only.
  kind: "stock" | "etf";
  tv: string;
  chart: { ok: true } | { ok: false; reason: string };
  price: Sourced | null;
  dayPct: number | null;
  estimate: Sourced | null;
  stats: { label: string; value: string; source: string }[];
  position: { quantity: number; valueCad: number | null; gainCad: number | null; gainCadPct: number | null; accounts: string[] } | null;
  earnings: Earnings | null;
  news: NewsItem[];
  notes: string;
  lists: { id: string; name: string; has: boolean }[];
  alerts: Alert[];
  asks: (Writeup & { question: string; status: "queued" | "running" | "done" | "failed"; taskId: string | null })[];
  refreshedAt: number | null;
};

export const REFRESH_EVERY_MS = 600_000;
const DAY_MS = 86_400_000;
const NEWS_SHOWN = 5;
const NEWS_DAYS = 30;
const EARNINGS_AHEAD = 120;
const ASKS_SHOWN = 3;
const refreshedKey = (key: string) => `markets.symbol.${key}.at`;

const prefix = (key: string) => (currencyOfKey(key) === "USD" ? "US$" : "CA$");
const amount = (key: string, n: number) => `${prefix(key)}${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
// Finnhub reports market cap in millions of the listing currency.
function cap(key: string, millions: number): string {
  const [v, unit] = millions >= 1e6 ? [millions / 1e6, "T"] : millions >= 1e3 ? [millions / 1e3, "B"] : [millions, "M"];
  return `${prefix(key)}${v.toFixed(2)}${unit}`;
}

function stats(db: Database, key: string, now: number): SymbolView["stats"] {
  const m = getMeta(db, [key]).get(key);
  const out: SymbolView["stats"] = [];
  if (m?.metricsAt) {
    const source = `Finnhub · metrics ${closeDayText(m.metricsAt)}`;
    if (m.marketCap) out.push({ label: "Market cap", value: cap(key, m.marketCap), source });
    if (m.pe !== null) out.push({ label: "P/E", value: m.pe.toFixed(1), source });
    if (m.low52 !== null && m.high52 !== null) out.push({ label: "52-week range", value: `${amount(key, m.low52)} – ${amount(key, m.high52)}`, source });
    if (m.divYield) out.push({ label: "Dividend yield", value: `${m.divYield.toFixed(2)}%`, source });
  }
  const today = cachedBars(db, key, "1Day", etInstant(etDate(now), "00:00") / 1000).at(-1);
  if (today) out.push({ label: "Day range", value: `${amount(key, today.l)} – ${amount(key, today.h)}`, source: "Daily bar · today" });
  return out;
}

function asks(db: Database, spaceId: string, key: string): SymbolView["asks"] {
  const tasks = listTasks(db, { spaceId }).filter((t) => t.purpose === "ask" && t.subject === key);
  const byTask = new Map(tasks.map((t) => [t.id, t]));
  const open = tasks
    .filter((t) => t.status === "queued" || t.status === "running")
    .map((t) => ({ id: t.id, kind: "ask", key, forDate: new Date(t.createdAt).toISOString(), body: "", taskId: t.id, createdAt: t.createdAt, question: t.detail, status: t.status as "queued" | "running" }));
  const done = latestWriteups(db, spaceId, { kind: "ask", key, limit: ASKS_SHOWN }).map((w) => {
    const t = w.taskId ? byTask.get(w.taskId) : undefined;
    return { ...w, question: t?.detail ?? "", status: (t?.status === "failed" ? "failed" : "done") as "done" | "failed" };
  });
  return [...open, ...done].slice(0, ASKS_SHOWN);
}

// Cache only: whatever the last refresh, the eod job or the feed saved. Opening a symbol never waits on the network.
export function symbolView(db: Database, data: MarketData, spaceId: string, key: string, now: number): SymbolView {
  const i = parseInstrumentKey(key)!;
  const k = instrumentKey(i);
  const meta = getMeta(db, [k]).get(k);
  const tv = tvSymbol(k, meta?.listing ?? null);
  const q = currentQuote(db, data, i);
  const proxy = ESTIMATED[k] ? parseInstrumentKey(ESTIMATED[k].proxy) : null;
  const holdings = listHoldings(db, spaceId).filter((h) => h.key === k);
  const row = holdings.length ? portfolioView(db, data, spaceId, now).holdings.find((h) => h.key === k) : undefined;
  const at = db.query("SELECT value FROM settings WHERE key = ?").get(refreshedKey(k)) as { value: string } | null;
  return {
    key: k,
    symbol: i.symbol,
    exchange: i.exchange,
    name: meta?.name || holdings[0]?.name || listLists(db, spaceId).flatMap((l) => listItems(db, l.id)).find((x) => x.key === k)?.name || "",
    kind: isFund(k) || meta?.kind === "etf" ? "etf" : "stock",
    tv,
    chart: widgetCoverage(tv),
    price: q ? quoteSourced(q, now) : null,
    dayPct: q?.prevClose ? (q.price / q.prevClose - 1) * 100 : null,
    estimate: proxy ? estimateFor(db, k, currentQuote(db, data, proxy), now) : null,
    stats: stats(db, k, now),
    position: holdings.length
      ? {
          quantity: holdings.reduce((s, h) => s + h.quantity, 0),
          valueCad: row?.valueCad ?? null,
          gainCad: row?.gainCad ?? null,
          gainCadPct: row?.gainCadPct ?? null,
          accounts: [...new Set(holdings.map((h) => h.account))],
        }
      : null,
    earnings: upcomingEarnings(db, [k], etDate(now), EARNINGS_AHEAD)[0] ?? null,
    news: recentNews(db, [k], now - NEWS_DAYS * DAY_MS, NEWS_SHOWN),
    notes: getNotes(db, spaceId, k).notes,
    lists: listLists(db, spaceId).map((l) => ({ id: l.id, name: l.name, has: listItems(db, l.id).some((x) => x.key === k) })),
    alerts: listAlerts(db, spaceId).filter((a) => a.key === k),
    asks: asks(db, spaceId, k),
    refreshedAt: at ? Number(at.value) : null,
  };
}

function failureNote(e: unknown, secrets: string[]): string {
  if (e instanceof ProviderError && e.kind === "rate_limited") return "Finnhub is busy. Try again in a minute.";
  return redact(e instanceof Error ? e.message : String(e), secrets);
}

const PROFILE_MAX_AGE = 30 * DAY_MS;
const METRICS_MAX_AGE = 7 * DAY_MS;
const NEWS_BACK_MS = 7 * DAY_MS;

// One refresh when the page opens, at most every ten minutes per key: a quote; the profile when it's missing or a month
// old (its listing picks the TradingView symbol); and, for stocks, key stats when missing or a week old, the next month
// of earnings, and recent company news (TradingView's news widget can lag by weeks). At most five Finnhub calls;
// provider errors become one plain note, never a throw.
export async function refreshSymbol(db: Database, data: MarketData, key: string, now: number): Promise<{ refreshed: boolean; note: string | null }> {
  const i = parseInstrumentKey(key);
  if (!i) return { refreshed: false, note: null };
  if (i.exchange !== "US") return { refreshed: false, note: data.reasonFor(i) ?? "Canadian prices refresh every 3 minutes during TSX hours." };
  const k = instrumentKey(i);
  const last = db.query("SELECT value FROM settings WHERE key = ?").get(refreshedKey(k)) as { value: string } | null;
  if (last && now - Number(last.value) < REFRESH_EVERY_MS) return { refreshed: false, note: null };
  // Written directly so the throttle itself doesn't wake every listener.
  db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(refreshedKey(k), String(now));

  const notes = new Set<string>();
  const secrets = data.secrets();
  const r = await data.quotes([i]);
  for (const m of r.missing) notes.add(m.reason);
  const p = data.research?.();
  if (p) {
    const stock = !isFund(k);
    const attempt = async (fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (e) {
        notes.add(failureNote(e, secrets));
      }
    };
    db.query("INSERT OR IGNORE INTO instrument_meta (key) VALUES (?)").run(k);
    const ages = db.query("SELECT profile_at, metrics_at FROM instrument_meta WHERE key = ?").get(k) as { profile_at: number | null; metrics_at: number | null };
    if (p.profile && now - (ages.profile_at ?? 0) > PROFILE_MAX_AGE) await attempt(async () => saveProfile(db, k, await p.profile!(i), now));
    if (stock && p.metric && now - (ages.metrics_at ?? 0) > METRICS_MAX_AGE) await attempt(async () => saveMetrics(db, k, await p.metric!(i), now));
    if (stock && p.earnings) {
      const from = etDate(now);
      const to = etDate(now + 30 * DAY_MS);
      await attempt(async () => saveEarnings(db, await p.earnings!([i], from, to), "finnhub", { replaceFrom: { keys: [k], from } }));
    }
    if (stock && p.news) {
      const newest = (db.query("SELECT MAX(at) AS at FROM market_news WHERE key = ?").get(k) as { at: number | null }).at;
      await attempt(async () => saveNews(db, await p.news!([i], Math.max(newest ?? 0, now - NEWS_BACK_MS)), now));
    }
  }
  bus.emit({ type: "changed" });
  // A rate limit reported by both the quote and the research calls reads once.
  const all = [...notes].map((n) => (/limit/i.test(n) && /Finnhub/.test(n) ? "Finnhub is busy. Try again in a minute." : n));
  return { refreshed: true, note: all.length ? [...new Set(all)].join(" ") : null };
}

export const ASK_MAX_CHARS = 500;

// Claude only: the answer may draw on his position and notes. An empty question asks for a quick overview.
export function requestAsk(db: Database, spaceId: string, key: string, question: string): Task {
  const q = question.trim();
  if (q.length > ASK_MAX_CHARS) throw new Error("Keep the question under 500 characters.");
  const open = listTasks(db, { spaceId, status: ["queued", "running"] }).some((t) => t.purpose === "ask" && t.subject === key);
  if (open) throw new Error(`Claude is already looking at ${key}.`);
  return createTask(db, { spaceId, title: `Ask Claude about ${key}`, detail: q, agent: "claude", weight: "light", allowOnBattery: true, purpose: "ask", subject: key });
}
