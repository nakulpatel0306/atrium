import type { Database } from "bun:sqlite";
import type { dailyBudget, hourlyBudget } from "../budget";
import { etDate, etInstant } from "../calendar";
import { instrumentKey, type Instrument } from "../instrument";
import { fetchJson } from "./http";
import { ProviderError, type Bar, type MarketProvider, type Quote } from "./types";

// Tiingo's free plan: daily closes, adjusted closes and dividends for US listings, for internal use. The token goes
// in the Authorization header, never the URL, so it can't leak through a logged or echoed URL.
const API = "https://api.tiingo.com/tiingo/daily";
const DAY_MS = 86_400_000;
const MONTHLY_SYMBOLS = 450;
const OVER_BUDGET = "Tiingo's free daily or hourly limit is reached; closes refresh later.";
const OVER_SYMBOLS = "Tiingo's free plan allows 500 symbols a month; Atrium stops at 450.";

type Row = { date: string; open: number; high: number; low: number; close: number; volume: number; adjClose: number; divCash: number };
export type TiingoDay = { bar: Bar; date: string; adjClose: number; divCash: number };
export type TiingoProvider = MarketProvider & { daily(i: Instrument, startDate: string): Promise<TiingoDay[]> };

// The distinct symbols asked for this month, kept under Tiingo's 500.
export function tiingoSymbols(db: Database, now: () => number): { allow(ticker: string): boolean } {
  return {
    allow(ticker) {
      const key = `markets.tiingo.symbols.${etDate(now()).slice(0, 7)}`;
      const row = db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null;
      const set = row ? (JSON.parse(row.value) as string[]) : [];
      if (set.includes(ticker)) return true;
      if (set.length >= MONTHLY_SYMBOLS) return false;
      db.transaction(() => {
        db.query("DELETE FROM settings WHERE key LIKE 'markets.tiingo.symbols.%' AND key != ?").run(key);
        db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify([...set, ticker]));
      })();
      return true;
    },
  };
}

const isoDaysAgo = (now: number, days: number) => etDate(now - days * DAY_MS);

export function tiingoProvider(
  token: string,
  deps: {
    fetch?: typeof fetch;
    now?: () => number;
    budget: { day: ReturnType<typeof dailyBudget>; hour: ReturnType<typeof hourlyBudget> };
    symbols: { allow(ticker: string): boolean };
  },
): TiingoProvider {
  const f = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;

  const daily = async (i: Instrument, startDate: string): Promise<TiingoDay[]> => {
    // Tiingo writes share classes with a dash (BRK-B).
    const ticker = i.symbol.replace(/\./g, "-");
    if (!deps.symbols.allow(ticker)) throw new ProviderError("rate_limited", OVER_SYMBOLS);
    if (deps.budget.day.remaining() < 1 || deps.budget.hour.remaining() < 1) throw new ProviderError("rate_limited", OVER_BUDGET);
    deps.budget.day.spend();
    deps.budget.hour.spend();
    const body = await fetchJson(`${API}/${encodeURIComponent(ticker)}/prices?startDate=${startDate}`, {
      fetch: f,
      name: "Tiingo",
      authMessage: "Tiingo rejected the token. Check it in Settings → Market data.",
      now,
      headers: { Authorization: `Token ${token}`, "Content-Type": "application/json" },
    });
    if (!Array.isArray(body)) throw new ProviderError("unknown_symbol", `Tiingo doesn't know ${instrumentKey(i)}.`);
    return (body as Row[])
      .filter((r) => typeof r?.date === "string" && Number.isFinite(r.close))
      .map((r) => {
        const date = r.date.slice(0, 10);
        return {
          date,
          bar: { t: etInstant(date, "00:00") / 1000, o: r.open, h: r.high, l: r.low, c: r.close, v: r.volume },
          adjClose: r.adjClose,
          divCash: Number(r.divCash) || 0,
        };
      })
      .sort((a, b) => a.bar.t - b.bar.t);
  };

  return {
    id: "tiingo",
    label: "Tiingo (end of day)",
    covers: (i) => i.exchange === "US",
    daily,
    async quotes(list) {
      const out: Quote[] = [];
      for (const i of list) {
        const days = await daily(i, isoDaysAgo(now(), 10));
        const last = days.at(-1);
        if (!last) continue;
        out.push({ key: instrumentKey(i), price: last.bar.c, prevClose: days.at(-2)?.bar.c ?? null, at: etInstant(last.date, "16:00"), source: "tiingo", freshness: "eod" });
      }
      return out;
    },
    async bars(i, tf, from, to) {
      if (tf !== "1Day") throw new ProviderError("no_history", "Tiingo's free plan has daily prices only.");
      const toSec = to / 1000;
      return (await daily(i, etDate(from))).map((d) => d.bar).filter((b) => b.t <= toSec);
    },
    async validate() {
      await daily({ symbol: "SPY", exchange: "US" }, isoDaysAgo(now(), 5));
    },
  };
}
