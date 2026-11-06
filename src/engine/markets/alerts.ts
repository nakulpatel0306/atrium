import type { Database } from "bun:sqlite";
import { advancedSpaces, isIndicatorRule } from "./advanced";
import { createApproval, type AlertTopic } from "../approvals";
import { bus, logActivity } from "../events";
import { newId } from "../ids";
import { cachedBars } from "./cache";
import { etClock, etDate, etInstant } from "./calendar";
import { rsi, sma } from "./indicators";
import { instrumentKey, parseInstrumentKey } from "./instrument";
import { currencyOfKey, describeRule, freshnessText, money, type AlertRule } from "./labels";
import { recentNews, upcomingEarnings } from "./events";
import type { Quote } from "./providers/types";

export type { AlertRule };
export { describeRule };

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

type Row = {
  id: string;
  space_id: string;
  key: string;
  rule: string;
  note: string;
  repeat: number;
  status: Alert["status"];
  last_fired_at: number | null;
  fired_for: string | null;
  created_at: number;
};

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

function validate(rule: AlertRule): void {
  const finite = (n: unknown) => typeof n === "number" && Number.isFinite(n);
  if ("level" in rule && (!finite(rule.level) || rule.level <= 0)) throw new Error("The alert level must be more than zero.");
  if (rule.kind === "pct_move" && (!finite(rule.pct) || rule.pct <= 0 || rule.pct > 50)) throw new Error("The move must be more than 0% and at most 50%.");
  if ("period" in rule && (!Number.isInteger(rule.period) || rule.period < 2 || rule.period > 200)) {
    throw new Error("The period must be a whole number from 2 to 200.");
  }
  if (rule.kind === "earnings_within" && (!Number.isInteger(rule.days) || rule.days < 1 || rule.days > 30)) {
    throw new Error("The number of days must be a whole number from 1 to 30.");
  }
  const kinds = ["price_above", "price_below", "pct_move", "rsi_below", "rsi_above", "cross_above_sma", "cross_below_sma", "earnings_within", "big_news"];
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
    // Event alerts are evaluated from stored earnings and news (evaluateEvents), never from quotes.
    case "earnings_within":
    case "big_news":
      return null;
  }
}

export function topicOf(rule: AlertRule): AlertTopic {
  if (rule.kind === "earnings_within") return "earnings";
  if (rule.kind === "big_news") return "news";
  return rule.kind.startsWith("rsi") || rule.kind.endsWith("_sma") ? "indicator" : "price";
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
    title: titleOf(a),
    topic: topicOf(a.rule),
    detail: `${a.key} at ${money(q.price, currencyOfKey(a.key))} (${freshnessText(q, now)}, ${etClock(q.at)}). Your alert: ${rule}.${note}\n\nAnalysis, not advice.`,
  });
  db.query("UPDATE market_alerts SET status = ?, last_fired_at = ? WHERE id = ?").run(a.repeat ? "fired" : "off", now, a.id);
  logActivity(db, a.spaceId, "atrium", `Alert: ${a.key} ${rule}`);
}

const titleOf = (a: Alert) => `${a.key} ${describeRule(a.rule)}`;

// An item Nakul hasn't answered yet already says this; a second one would only repeat it.
const waiting = (db: Database, a: Alert) =>
  !!db.query("SELECT 1 FROM approvals WHERE space_id = ? AND kind = 'alert' AND status = 'pending' AND title = ? LIMIT 1").get(a.spaceId, titleOf(a));

// Indicator rules flip with every tick around a level, so each fires at most once per trading session.
const firedToday = (a: Alert, now: number) => a.lastFiredAt !== null && etDate(a.lastFiredAt) === etDate(now);

export function evaluateQuotes(db: Database, quotes: Quote[], now: number): number {
  let fired = 0;
  const adv = advancedSpaces(db);
  for (const q of quotes) {
    const rows = db
      .query(
        "SELECT a.* FROM market_alerts a JOIN spaces s ON s.id = a.space_id WHERE a.key = ? AND a.status != 'off' AND s.status = 'active' AND s.kind = 'markets'",
      )
      .all(q.key) as Row[];
    for (const row of rows) {
      const a = toAlert(row);
      if (a.rule.kind === "earnings_within" || a.rule.kind === "big_news") continue;
      if (q.freshness === "eod") {
        if (lastEodAt.get(a.id) === q.at) continue;
        lastEodAt.set(a.id, q.at);
      }
      const indicator = isIndicatorRule(a.rule.kind);
      // Indicator alerts are an Advanced tool: kept armed, not evaluated, while their space has it off.
      if (indicator && !adv.has(a.spaceId)) continue;
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
      if (status === "armed" && holds && !(indicator && firedToday(a, now)) && !waiting(db, a)) {
        fire(db, a, q, now);
        fired++;
      }
    }
  }
  return fired;
}

// Words that make a headline worth interrupting Nakul for.
export const BIG_NEWS =
  /\b(earnings|guidance|acquir\w*|merger|buyout|takeover|offering|downgrade\w*|upgrade\w*|FDA|SEC|lawsuit|recall\w*|bankrupt\w*|CEO|resign\w*|investigation|halt\w*|split|contract)\b/i;

const weekdayFmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
const HOURS: Record<string, string> = { amc: " (after close)", bmo: " (before open)", dmh: " (during market hours)" };
const DAY_MS = 86_400_000;

// Earnings and big-news alerts, from what the end-of-day and news jobs stored. Called after each of those saves.
export function evaluateEvents(db: Database, now: number): number {
  const rows = db
    .query(
      `SELECT a.* FROM market_alerts a JOIN spaces s ON s.id = a.space_id
       WHERE a.status != 'off' AND s.status = 'active' AND s.kind = 'markets' AND a.rule LIKE '%"kind":"earnings_within"%'
       UNION ALL
       SELECT a.* FROM market_alerts a JOIN spaces s ON s.id = a.space_id
       WHERE a.status != 'off' AND s.status = 'active' AND s.kind = 'markets' AND a.rule LIKE '%"kind":"big_news"%'`,
    )
    .all() as Row[];
  const today = etDate(now);
  let fired = 0;
  for (const row of rows) {
    const a = toAlert(row);
    if (a.rule.kind === "earnings_within") {
      const next = upcomingEarnings(db, [a.key], today, a.rule.days)[0];
      if (!next || row.fired_for === next.date) continue;
      const day = weekdayFmt.format(Date.parse(`${next.date}T12:00:00Z`));
      const eps = next.epsEstimate !== null ? ` EPS estimate ${next.epsEstimate}.` : "";
      const source = next.source === "you" ? "Entered by you" : "Finnhub";
      raise(db, a, `Earnings on ${day}${HOURS[next.hour ?? ""] ?? ""}.${eps} Source: ${source}.`, now, next.date);
      fired++;
    } else if (a.rule.kind === "big_news") {
      if (a.lastFiredAt !== null && etDate(a.lastFiredAt) === today) continue;
      const item = recentNews(db, [a.key], Math.max(a.createdAt, now - DAY_MS), 50).find((n) => BIG_NEWS.test(n.headline));
      if (!item) continue;
      raise(db, a, `${item.headline}\n${item.source} · ${etClock(item.at)}\n${item.url}`, now, null);
      fired++;
    }
  }
  return fired;
}

function raise(db: Database, a: Alert, detail: string, now: number, firedFor: string | null): void {
  createApproval(db, { spaceId: a.spaceId, kind: "alert", title: titleOf(a), topic: topicOf(a.rule), detail });
  db.query("UPDATE market_alerts SET status = ?, last_fired_at = ?, fired_for = COALESCE(?, fired_for) WHERE id = ?").run(a.repeat ? "armed" : "off", now, firedFor, a.id);
  logActivity(db, a.spaceId, "atrium", `Alert: ${titleOf(a)}`);
}
