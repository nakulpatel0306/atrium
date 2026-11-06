import type { Database } from "bun:sqlite";
import { bus } from "../events";
import { newId } from "../ids";
import { createTask, type Task, type TaskPurpose } from "../tasks";
import { etDate, etInstant } from "./calendar";
import { recentNews, upcomingEarnings } from "./events";
import { getSetting } from "../settings";
import { cachedQuotes } from "./cache";
import { instrumentKey, type Exchange } from "./instrument";
import type { Job } from "./jobs";

const MAX_CHARS = 20_000;
const DAY_MS = 86_400_000;
const ACTIVE = "SELECT id FROM spaces WHERE kind = 'markets' AND status = 'active'";

export type Writeup = { id: string; kind: string; key: string | null; forDate: string; body: string; taskId: string | null; createdAt: number };

export function getNotes(db: Database, spaceId: string, key: string): { thesis: string; notes: string; updatedAt: number | null } {
  const r = db.query("SELECT thesis, notes, updated_at FROM research_notes WHERE space_id = ? AND key = ?").get(spaceId, key) as { thesis: string; notes: string; updated_at: number } | null;
  return r ? { thesis: r.thesis, notes: r.notes, updatedAt: r.updated_at } : { thesis: "", notes: "", updatedAt: null };
}

export function saveNotes(db: Database, spaceId: string, key: string, patch: { thesis?: string; notes?: string }): void {
  for (const v of [patch.thesis, patch.notes]) if (v !== undefined && (typeof v !== "string" || v.length > MAX_CHARS)) throw new Error("Keep it under 20,000 characters.");
  const cur = getNotes(db, spaceId, key);
  db.query(
    `INSERT INTO research_notes (space_id, key, thesis, notes, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(space_id, key) DO UPDATE SET thesis = excluded.thesis, notes = excluded.notes, updated_at = excluded.updated_at`,
  ).run(spaceId, key, patch.thesis ?? cur.thesis, patch.notes ?? cur.notes, Date.now());
  bus.emit({ type: "changed" });
}

type WriteupRow = { id: string; kind: string; key: string | null; for_date: string; body: string; task_id: string | null; created_at: number };
const toWriteup = (r: WriteupRow): Writeup => ({ id: r.id, kind: r.kind, key: r.key, forDate: r.for_date, body: r.body, taskId: r.task_id, createdAt: r.created_at });

export function latestWriteups(db: Database, spaceId: string, opts: { kind?: TaskPurpose; key?: string; limit?: number } = {}): Writeup[] {
  const where = ["space_id = ?"];
  const params: (string | number)[] = [spaceId];
  if (opts.kind) {
    where.push("kind = ?");
    params.push(opts.kind);
  }
  if (opts.key) {
    where.push("key = ?");
    params.push(opts.key);
  }
  params.push(opts.limit ?? 20);
  return (db.query(`SELECT * FROM market_writeups WHERE ${where.join(" AND ")} ORDER BY for_date DESC, created_at DESC LIMIT ?`).all(...params) as WriteupRow[]).map(toWriteup);
}

// One write-up per space, kind, symbol and date; a later one for the same day replaces it.
export function saveWriteup(db: Database, w: { spaceId: string; kind: TaskPurpose; key: string | null; forDate: string; body: string; taskId: string | null }): void {
  db.transaction(() => {
    db.query("DELETE FROM market_writeups WHERE space_id = ? AND kind = ? AND key IS ? AND for_date = ?").run(w.spaceId, w.kind, w.key, w.forDate);
    db.query("INSERT INTO market_writeups (id, space_id, kind, key, for_date, body, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      newId("wrt"),
      w.spaceId,
      w.kind,
      w.key,
      w.forDate,
      w.body,
      w.taskId,
      Date.now(),
    );
  })();
}

const openTask = (db: Database, spaceId: string, purpose: TaskPurpose, subject: string | null, since = 0) =>
  !!db
    .query("SELECT 1 FROM tasks WHERE space_id = ? AND purpose = ? AND subject IS ? AND created_at >= ? AND status IN ('queued','running') LIMIT 1")
    .get(spaceId, purpose, subject, since);

const claudeTask = (db: Database, spaceId: string, title: string, purpose: TaskPurpose, subject?: string): Task =>
  createTask(db, { spaceId, title, agent: "claude", weight: "light", allowOnBattery: true, purpose, subject });

export function requestThesisDraft(db: Database, spaceId: string, key: string): Task {
  if (openTask(db, spaceId, "thesis_draft", key)) throw new Error(`Claude is already drafting a thesis for ${key}.`);
  return claudeTask(db, spaceId, `Draft a thesis for ${key}`, "thesis_draft", key);
}

function spaceKeys(db: Database, spaceId: string): string[] {
  const rows = db
    .query("SELECT symbol, exchange FROM market_holdings WHERE space_id = ? UNION SELECT symbol, exchange FROM market_watchlist WHERE space_id = ?")
    .all(spaceId, spaceId) as { symbol: string; exchange: Exchange }[];
  return [...new Set(rows.map(instrumentKey))];
}
// A holding with a cached price from the current mode (demo prices only count in Demo mode).
function hasPricedHoldings(db: Database, spaceId: string): boolean {
  const keys = (db.query("SELECT symbol, exchange FROM market_holdings WHERE space_id = ?").all(spaceId) as { symbol: string; exchange: Exchange }[]).map(instrumentKey);
  const demo = getSetting(db, "markets.provider") === "demo";
  return [...cachedQuotes(db, keys).values()].some((q) => (q.source === "demo") === demo);
}
const activeSpaces = (db: Database) => (db.query(ACTIVE).all() as { id: string }[]).map((r) => r.id);

// After the close on weekdays: one Claude digest per markets space with something to write about (priced holdings,
// or headlines since the last digest). No network. A slot missed on an earlier day isn't caught up: yesterday's
// digest written today would be about today's prices.
export function digestJob(db: Database): Job {
  return {
    name: "digest",
    slot: { at: "17:15", days: "weekdays" },
    async run(now) {
      const today = etDate(now);
      const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
      if (dow === 0 || dow === 6 || now < etInstant(today, "17:15")) return;
      const midnight = etInstant(today, "00:00");
      for (const spaceId of activeSpaces(db)) {
        const keys = spaceKeys(db, spaceId);
        if (!keys.length) continue;
        const last = latestWriteups(db, spaceId, { kind: "digest", limit: 1 })[0];
        if (last?.forDate === today) continue;
        const queuedToday = db.query("SELECT 1 FROM tasks WHERE space_id = ? AND purpose = 'digest' AND created_at >= ? LIMIT 1").get(spaceId, midnight);
        if (queuedToday) continue;
        const news = recentNews(db, keys, last?.createdAt ?? now - DAY_MS, 1).length > 0;
        if (!news && !hasPricedHoldings(db, spaceId)) continue;
        claudeTask(db, spaceId, "Daily digest: what moved and why", "digest");
      }
    },
  };
}

const dayFmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
const plus = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
export const thesisCheckTitle = (key: string, date: string) => `Thesis check before ${key} earnings on ${date}`;

// One to three days before each earnings date: Claude checks Nakul's thesis, or, with no thesis, a reminder card.
export function thesisChecks(db: Database, now: number): number {
  const today = etDate(now);
  let n = 0;
  for (const spaceId of activeSpaces(db)) {
    for (const e of upcomingEarnings(db, spaceKeys(db, spaceId), plus(today, 1), 2)) {
      if (latestWriteups(db, spaceId, { kind: "thesis_check", key: e.key }).some((w) => w.forDate === e.date)) continue;
      if (db.query("SELECT 1 FROM tasks WHERE space_id = ? AND title = ? LIMIT 1").get(spaceId, thesisCheckTitle(e.key, e.date))) continue;
      if (!getNotes(db, spaceId, e.key).thesis.trim()) {
        const day = dayFmt.format(Date.parse(`${e.date}T12:00:00Z`));
        saveWriteup(db, { spaceId, kind: "thesis_check", key: e.key, forDate: e.date, body: `No thesis yet for ${e.key}. Write one, or ask Claude to draft it, before earnings on ${day}.`, taskId: null });
      } else claudeTask(db, spaceId, thesisCheckTitle(e.key, e.date), "thesis_check", e.key);
      n++;
    }
  }
  return n;
}
