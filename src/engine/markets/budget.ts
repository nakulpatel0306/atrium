import type { Database } from "bun:sqlite";
import { etDate, etParts } from "./calendar";
import { edgarStatus } from "./edgar";

// Counted per ET date in the settings table. Written directly rather than through setSetting so a spend doesn't
// emit `changed` and wake every listener for a counter nobody displays live.
// exhaust() marks the day used up when the provider itself says its daily limit is reached.
export function dailyBudget(db: Database, name: string, limit: number, now: () => number): { remaining(): number; spend(): boolean; exhaust(): void } {
  const prefix = `markets.budget.${name}.`;
  const used = () => {
    const row = db.query("SELECT value FROM settings WHERE key = ?").get(prefix + etDate(now())) as { value: string } | null;
    return row ? Number(row.value) : 0;
  };
  const set = (n: number) => {
    const key = prefix + etDate(now());
    db.transaction(() => {
      db.query("DELETE FROM settings WHERE key LIKE ? AND key != ?").run(`${prefix}%`, key);
      db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(n));
    })();
  };
  return {
    remaining: () => Math.max(0, limit - used()),
    spend() {
      const n = used();
      if (n >= limit) return false;
      set(n + 1);
      return true;
    },
    exhaust: () => set(Math.max(limit, used())),
  };
}

// Hourly counterpart of dailyBudget, keyed by ET date and hour.
export function hourlyBudget(db: Database, name: string, limit: number, now: () => number): { remaining(): number; spend(): boolean } {
  const prefix = `markets.budget.${name}.hour.`;
  const slot = () => {
    const p = etParts(now());
    return `${prefix}${p.date}T${p.hhmm.slice(0, 2)}`;
  };
  const used = () => {
    const row = db.query("SELECT value FROM settings WHERE key = ?").get(slot()) as { value: string } | null;
    return row ? Number(row.value) : 0;
  };
  return {
    remaining: () => Math.max(0, limit - used()),
    spend() {
      const n = used();
      if (n >= limit) return false;
      const key = slot();
      db.transaction(() => {
        db.query("DELETE FROM settings WHERE key LIKE ? AND key != ?").run(`${prefix}%`, key);
        db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(n + 1));
      })();
      return true;
    },
  };
}

export type DataSource = "alpaca" | "finnhub" | "alphavantage" | "tiingo" | "yahoo" | "boc" | "ishares" | "ssga" | "roundhill" | "invesco" | "wikipedia" | "edgar";

// Yahoo publishes no limit for its public feed, so Atrium sets its own: three TSX holdings polled every 3 minutes in
// session is about 400 a day.
export const YAHOO_DAILY_CAP = 2000;

const FUND_FILE = "one file a week per fund";
export const SOURCE_INFO: Record<DataSource, { label: string; limit: string; perDay?: number }> = {
  alpaca: { label: "Alpaca", limit: "200 a minute" },
  finnhub: { label: "Finnhub", limit: "60 a minute" },
  alphavantage: { label: "Alpha Vantage", limit: "25 a day", perDay: 25 },
  tiingo: { label: "Tiingo", limit: "1,000 a day, 50 an hour", perDay: 1000 },
  yahoo: { label: "Yahoo Finance", limit: `unofficial, no fixed limit; Atrium stops at ${YAHOO_DAILY_CAP.toLocaleString("en-US")} a day and pauses 15 minutes after an error`, perDay: YAHOO_DAILY_CAP },
  boc: { label: "Bank of Canada", limit: "no published limit; Atrium uses ≤ 4 a day" },
  ishares: { label: "iShares", limit: FUND_FILE },
  ssga: { label: "SSGA", limit: FUND_FILE },
  roundhill: { label: "Roundhill", limit: FUND_FILE },
  invesco: { label: "Invesco", limit: FUND_FILE },
  wikipedia: { label: "Wikipedia", limit: FUND_FILE },
  edgar: { label: "SEC EDGAR", limit: "10 a second; Atrium uses a few a month" },
};
const SOURCES = Object.keys(SOURCE_INFO) as DataSource[];

const upsert = (db: Database, key: string, value: string) =>
  db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
const readSetting = (db: Database, key: string): string | null =>
  (db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null)?.value ?? null;

// Counts every request a source is sent, per ET date, for the data budget page. Written directly (no `changed`).
export function meteredFetch(db: Database, source: DataSource, f: typeof fetch, now: () => number): typeof fetch {
  const prefix = `markets.calls.${source}.`;
  const counted = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const key = prefix + etDate(now());
    db.transaction(() => {
      db.query("DELETE FROM settings WHERE key LIKE ? AND key != ?").run(`${prefix}%`, key);
      upsert(db, key, String(Number(readSetting(db, key) ?? 0) + 1));
    })();
    return f(input, init);
  }) as typeof fetch;
  return counted;
}

type SourceState = { lastOkAt: number | null; lastError: string | null; lastErrorAt: number | null };

// The caller passes an already redacted message.
export function noteSourceResult(db: Database, source: DataSource, ok: boolean, message?: string, now: number = Date.now()): void {
  const key = `markets.source.${source}`;
  const raw = readSetting(db, key);
  const cur: SourceState = raw ? (JSON.parse(raw) as SourceState) : { lastOkAt: null, lastError: null, lastErrorAt: null };
  const next: SourceState = ok ? { lastOkAt: now, lastError: null, lastErrorAt: null } : { ...cur, lastError: message ?? "Failed.", lastErrorAt: now };
  upsert(db, key, JSON.stringify(next));
}

export type BudgetRow = {
  source: DataSource;
  label: string;
  callsToday: number;
  limit: string;
  perDay: number | null;
  lastOkAt: number | null;
  lastError: string | null;
  // A plain status line instead of an error, e.g. "Off — add a contact email" for SEC EDGAR.
  note: string | null;
};

export function dataBudget(db: Database, now: number): BudgetRow[] {
  const date = etDate(now);
  return SOURCES.map((source) => {
    const info = SOURCE_INFO[source];
    const raw = readSetting(db, `markets.source.${source}`);
    const state: SourceState | null = raw ? (JSON.parse(raw) as SourceState) : null;
    return {
      source,
      label: info.label,
      callsToday: Number(readSetting(db, `markets.calls.${source}.${date}`) ?? 0),
      limit: info.limit,
      perDay: info.perDay ?? null,
      lastOkAt: state?.lastOkAt ?? null,
      lastError: state?.lastError ?? null,
      note: source === "edgar" ? edgarStatus(db, now).note : null,
    };
  });
}

// Alpha Vantage's free 25 a day: Nakul keeps a few for his own chart and Test clicks.
export const AV_RESERVE = 5;

export function planAlphaVantage(i: { held: string[]; watched: string[]; used: number; limit: number; reserve: number }): {
  eod: string[];
  deferred: string[];
  spare: number;
} {
  const order = [...new Set([...i.held, ...i.watched])];
  const available = Math.max(0, i.limit - i.used - i.reserve);
  const eod = order.slice(0, available);
  return { eod, deferred: order.slice(available), spare: available - eod.length };
}
