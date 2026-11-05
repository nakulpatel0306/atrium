import type { Database } from "bun:sqlite";
import { createApproval } from "../approvals";
import { bus, logActivity } from "../events";
import { newId } from "../ids";
import { cachedBars } from "./cache";
import { etClock, etDate, etInstant } from "./calendar";
import { rsi, sma } from "./indicators";
import { instrumentKey, parseInstrumentKey } from "./instrument";
import { currencyOfKey, freshnessText, money } from "./labels";
import type { Quote } from "./providers/types";

export type AlertRule =
  | { kind: "price_above" | "price_below"; level: number }
  | { kind: "pct_move"; pct: number }
  | { kind: "rsi_below" | "rsi_above"; level: number; period: number }
  | { kind: "cross_above_sma" | "cross_below_sma"; period: number };

export type Alert = {
  id: string;
  spaceId: string;
  key: string;
  rule: AlertRule;
  note: string;
  repeat: boolean;
  status: "armed" | "fired" | "off";
  lastFiredAt: number | null;
  createdAt: number;
};

// A price alert re-arms only after the price moves this far back across its level, so a price hovering at the
// level gives one Needs-you item, not one per tick.
export const HYSTERESIS = 0.005;
const INDICATOR_EVERY_MS = 60_000;

type Row = { id: string; space_id: string; key: string; rule: string; note: string; repeat: number; status: Alert["status"]; last_fired_at: number | null; created_at: number };

const toAlert = (r: Row): Alert => ({
  id: r.id,
  spaceId: r.space_id,
  key: r.key,
  rule: JSON.parse(r.rule) as AlertRule,
  note: r.note,
  repeat: r.repeat === 1,
  status: r.status,
  lastFiredAt: r.last_fired_at,
  createdAt: r.created_at,
});

export function describeRule(rule: AlertRule): string {
  switch (rule.kind) {
    case "price_above":
      return `price above ${money(rule.level, "USD")}`;
    case "price_below":
      return `price below ${money(rule.level, "USD")}`;
    case "pct_move":
      return `moves ${rule.pct}% in a day`;
    case "rsi_below":
      return `RSI(${rule.period}) below ${rule.level}`;
    case "rsi_above":
      return `RSI(${rule.period}) above ${rule.level}`;
    case "cross_above_sma":
      return `crosses above SMA ${rule.period}`;
    case "cross_below_sma":
      return `crosses below SMA ${rule.period}`;
  }
}

function validate(rule: AlertRule): void {
  const finite = (n: unknown) => typeof n === "number" && Number.isFinite(n);
  if ("level" in rule && (!finite(rule.level) || rule.level <= 0)) throw new Error("The alert level must be more than zero.");
  if (rule.kind === "pct_move" && (!finite(rule.pct) || rule.pct <= 0 || rule.pct > 50)) throw new Error("The move must be more than 0% and at most 50%.");
  if ("period" in rule && (!Number.isInteger(rule.period) || rule.period < 2 || rule.period > 200)) {
    throw new Error("The period must be a whole number from 2 to 200.");
  }
  const kinds = ["price_above", "price_below", "pct_move", "rsi_below", "rsi_above", "cross_above_sma", "cross_below_sma"];
  if (!kinds.includes(rule.kind)) throw new Error("That isn't a kind of alert Atrium knows.");
}

const getAlert = (db: Database, id: string): Alert | null => {
  const row = db.query("SELECT * FROM market_alerts WHERE id = ?").get(id) as Row | null;
  return row ? toAlert(row) : null;
};

export function createAlert(db: Database, input: { spaceId: string; key: string; rule: AlertRule; note?: string; repeat?: boolean }): Alert {
  const inst = parseInstrumentKey(input.key);
  if (!inst) throw new Error("Type a symbol like AAPL or SHOP.TO.");
  validate(input.rule);
  const id = newId("alr");
  db.query("INSERT INTO market_alerts (id, space_id, key, rule, note, repeat, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'armed', ?)").run(
    id,
    input.spaceId,
    instrumentKey(inst),
    JSON.stringify(input.rule),
    input.note?.trim() ?? "",
    input.repeat === false ? 0 : 1,
    Date.now(),
  );
  bus.emit({ type: "changed" });
  return getAlert(db, id)!;
}

export function listAlerts(db: Database, spaceId: string): Alert[] {
  return (db.query("SELECT * FROM market_alerts WHERE space_id = ? ORDER BY created_at, rowid").all(spaceId) as Row[]).map(toAlert);
}

export function setAlertStatus(db: Database, id: string, status: "armed" | "off"): Alert {
  if (!getAlert(db, id)) throw new Error(`No alert with id ${id}`);
  db.query("UPDATE market_alerts SET status = ? WHERE id = ?").run(status, id);
  bus.emit({ type: "changed" });
  return getAlert(db, id)!;
}

export function removeAlert(db: Database, id: string): void {
  db.query("DELETE FROM market_alerts WHERE id = ?").run(id);
  bus.emit({ type: "changed" });
}

// In memory: losing these on restart costs at most one extra evaluation, and a fired alert stays fired in the DB.
const lastIndicatorEval = new Map<string, number>();
const lastEodAt = new Map<string, number>();

// Daily closes with the quote as today's provisional close (replacing a cached bar for the same date).
function closesWithQuote(db: Database, q: Quote): number[] {
  const bars = cachedBars(db, q.key, "1Day", 0);
  const quoteDay = etInstant(etDate(q.at), "00:00") / 1000;
  const closes = bars.filter((b) => b.t < quoteDay).map((b) => b.c);
  closes.push(q.price);
  return closes;
}

// Whether the rule's condition holds right now; null when there isn't enough data to say.
function condition(db: Database, a: Alert, q: Quote): boolean | null {
  const r = a.rule;
  switch (r.kind) {
    case "price_above":
      return q.price > r.level;
    case "price_below":
      return q.price < r.level;
    case "pct_move":
      return q.prevClose ? Math.abs((q.price / q.prevClose - 1) * 100) >= r.pct : null;
    case "rsi_below":
    case "rsi_above": {
      const v = rsi(closesWithQuote(db, q), r.period).at(-1);
      if (v == null) return null;
      return r.kind === "rsi_below" ? v < r.level : v > r.level;
    }
    case "cross_above_sma":
    case "cross_below_sma": {
      const closes = closesWithQuote(db, q);
      const s = sma(closes, r.period);
      const [p0, s0, p1, s1] = [closes.at(-2), s.at(-2), closes.at(-1), s.at(-1)];
      if (p0 == null || s0 == null || p1 == null || s1 == null) return null;
      return r.kind === "cross_above_sma" ? p0 <= s0 && p1 > s1 : p0 >= s0 && p1 < s1;
    }
  }
}

// Whether a fired alert may fire again.
function rearmed(a: Alert, q: Quote, now: number, holds: boolean | null): boolean {
  const r = a.rule;
  if (r.kind === "price_above") return q.price <= r.level * (1 - HYSTERESIS);
  if (r.kind === "price_below") return q.price >= r.level * (1 + HYSTERESIS);
  if (r.kind === "pct_move") return a.lastFiredAt === null || etDate(a.lastFiredAt) !== etDate(now);
  return holds === false;
}

function fire(db: Database, a: Alert, q: Quote, now: number): void {
  const rule = describeRule(a.rule);
  const note = a.note ? ` Note: ${a.note}` : "";
  createApproval(db, {
    spaceId: a.spaceId,
    kind: "alert",
    title: `${a.key} ${rule}`,
    detail: `${a.key} at ${money(q.price, currencyOfKey(a.key))} (${freshnessText(q)}, ${etClock(q.at)}). Your alert: ${rule}.${note}\n\nAnalysis, not advice.`,
  });
  db.query("UPDATE market_alerts SET status = ?, last_fired_at = ? WHERE id = ?").run(a.repeat ? "fired" : "off", now, a.id);
  logActivity(db, a.spaceId, "atrium", `Alert: ${a.key} ${rule}`);
}

export function evaluateQuotes(db: Database, quotes: Quote[], now: number): number {
  let fired = 0;
  for (const q of quotes) {
    const rows = db
      .query(
        "SELECT a.* FROM market_alerts a JOIN spaces s ON s.id = a.space_id WHERE a.key = ? AND a.status != 'off' AND s.status = 'active' AND s.kind = 'markets'",
      )
      .all(q.key) as Row[];
    for (const row of rows) {
      const a = toAlert(row);
      if (q.freshness === "eod") {
        if (lastEodAt.get(a.id) === q.at) continue;
        lastEodAt.set(a.id, q.at);
      }
      const indicator = a.rule.kind.startsWith("rsi") || a.rule.kind.startsWith("cross");
      if (indicator) {
        const last = lastIndicatorEval.get(a.id);
        if (last !== undefined && now - last < INDICATOR_EVERY_MS) continue;
        lastIndicatorEval.set(a.id, now);
      }
      const holds = condition(db, a, q);
      let status = a.status;
      if (status === "fired" && a.repeat && rearmed(a, q, now, holds)) {
        db.query("UPDATE market_alerts SET status = 'armed' WHERE id = ?").run(a.id);
        status = "armed";
      }
      if (status === "armed" && holds) {
        fire(db, a, q, now);
        fired++;
      }
    }
  }
  return fired;
}
