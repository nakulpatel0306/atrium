import type { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { fingerprintOf, legacyMask, maskNumbers, storeRow, type MoneyRow } from "./import";

// The highest row already checked; rows written after it (by anything but today's importer) are checked on next open.
const REMASK_KEY = "money.remaskedThrough";
// The version of the full pass: v2 also covers answers, write-ups, reviews and transcripts. A database that ran only
// v1 (money tables alone) runs the full pass again.
const VERSION_KEY = "money.remask.v2";

type Row = { id: string; space_id: string; source: "bank" | "wealthsimple"; account: string; date: string; description: string; merchant: string; amount: number; currency: "CAD" | "USD"; kind: string; symbol: string | null };

// Once: every money row stored by an earlier masker goes through today's, fingerprints are rebuilt from the masked
// rows, and a row the old masker stored with a date hidden ("UBER TRIP ··1001") is dropped when the same transaction
// is also here with its date ("UBER TRIP 2026-10-01"). Import records, reminders, budgets, rules and the answers to
// earlier money asks are re-masked too.
// Safe to run again and on an empty table. Later opens only re-check rows added since.
// True when it may have changed anything (always for the full pass), so the caller pushes old text out of the WAL
// and free pages.
export function remaskMoney(db: Database): boolean {
  const done = db.query("SELECT value FROM settings WHERE key = ?").get(REMASK_KEY) as { value: string } | null;
  const top = (db.query("SELECT COALESCE(MAX(rowid), 0) AS n FROM money_transactions").get() as { n: number }).n;
  const set = (key: string, value: string) => db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  const mark = (n: number) => set(REMASK_KEY, String(n));
  const v2 = db.query("SELECT 1 FROM settings WHERE key = ?").get(VERSION_KEY);
  if (done && v2) {
    const since = Number(done.value);
    return top > since ? db.transaction(() => recheck(db, since, top, mark))() : false;
  }
  return db.transaction(() => {
    const rows = db.query("SELECT id, space_id, source, account, date, description, merchant, amount, currency, kind, symbol FROM money_transactions ORDER BY rowid").all() as Row[];
    const clean = rows.map((r) => ({ ...r, ...storeRow({ ...r, kind: r.kind as MoneyRow["kind"] }) }));

    // A legacy twin: same space, source, date and amount, an account that matches (or the old "Imported"), and a
    // description equal to what the old masker made of the newer row's.
    const gone = new Set<string>();
    const byKey = new Map<string, typeof clean>();
    for (const r of clean) {
      const key = `${r.space_id}|${r.source}|${r.date}|${r.amount.toFixed(2)}`;
      const list = byKey.get(key);
      if (list) list.push(r);
      else byKey.set(key, [r]);
    }
    for (const list of byKey.values()) {
      if (list.length < 2) continue;
      for (const keep of list) {
        const old = legacyMask(keep.description);
        if (old === keep.description || gone.has(keep.id)) continue;
        const twin = list.find((o) => o.id !== keep.id && !gone.has(o.id) && o.description === old && (o.account === keep.account || o.account === "Imported"));
        if (twin) gone.add(twin.id);
      }
    }

    const del = db.query("DELETE FROM money_transactions WHERE id = ?");
    for (const id of gone) del.run(id);
    // Fingerprints are unique per space, so they're cleared first and rebuilt in the rows' original order.
    db.query("UPDATE money_transactions SET fingerprint = 'remask:' || id").run();
    const put = db.query("UPDATE money_transactions SET account = ?, description = ?, merchant = ?, symbol = ?, fingerprint = ? WHERE id = ?");
    const seen = new Map<string, number>();
    for (const r of clean) {
      if (gone.has(r.id)) continue;
      const base = `${r.space_id}|${[r.source, r.account, r.date, r.amount.toFixed(2), r.currency, r.description.toLowerCase()].join("|")}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      put.run(r.account, r.description, r.merchant, r.symbol, fingerprintOf(r, n), r.id);
    }

    // Every other text column that can hold money text: import records, reminders, budgets, rules, and the answers
    // to Plan 10 money asks (write-ups, the task's text, its review, and its transcripts on disk).
    const remaskColumn = (table: string, key: string, column: string, where = "1") => {
      for (const r of db.query(`SELECT ${key} AS k, ${column} AS v FROM ${table} WHERE ${where}`).all() as { k: string; v: string | null }[]) {
        if (r.v === null) continue;
        const v = maskNumbers(r.v);
        if (v === r.v) continue;
        db.query(`UPDATE OR IGNORE ${table} SET ${column} = ? WHERE ${key} = ?`).run(v, r.k);
      }
    };
    remaskColumn("money_imports", "id", "account");
    remaskColumn("money_nudges", "id", "title");
    remaskColumn("money_nudges", "id", "body");
    remaskColumn("money_budgets", "rowid", "category");
    remaskColumn("settings", "key", "value", "key LIKE 'money.rules.%'");
    remaskColumn("market_writeups", "id", "body", "kind = 'money'");
    remaskColumn("tasks", "id", "detail", "purpose = 'money'");
    remaskColumn("approvals", "id", "detail", "task_id IN (SELECT id FROM tasks WHERE purpose = 'money')");
    remaskColumn("approvals", "id", "note", "task_id IN (SELECT id FROM tasks WHERE purpose = 'money')");
    for (const r of db.query("SELECT transcript_path AS p FROM runs WHERE task_id IN (SELECT id FROM tasks WHERE purpose = 'money') AND transcript_path IS NOT NULL").all() as { p: string }[]) {
      remaskTranscript(r.p);
    }
    mark(top);
    set(VERSION_KEY, "1");
    // Always true for the full pass, so the caller checkpoints and vacuums whatever an earlier version left behind.
    return true;
  })();
}

// A transcript file, masked as one text and rewritten; false when it's gone or already masked.
export function remaskTranscript(path: string): boolean {
  try {
    const text = readFileSync(path, "utf8");
    const masked = maskNumbers(text);
    if (masked === text) return false;
    writeFileSync(path, masked);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.error(`Couldn't re-mask a money transcript: ${(e as Error).message}`);
    return false;
  }
}

// Rows added since the last check: masked again where they need it, with a fresh fingerprint.
function recheck(db: Database, since: number, top: number, mark: (n: number) => void): boolean {
  let changed = false;
  const rows = db.query("SELECT id, space_id, source, account, date, description, merchant, amount, currency, kind, symbol FROM money_transactions WHERE rowid > ? AND rowid <= ?").all(since, top) as Row[];
  const taken = db.query("SELECT 1 FROM money_transactions WHERE space_id = ? AND fingerprint = ? AND id != ?");
  const put = db.query("UPDATE money_transactions SET account = ?, description = ?, merchant = ?, symbol = ?, fingerprint = ? WHERE id = ?");
  for (const r of rows) {
    const c = storeRow({ ...r, kind: r.kind as MoneyRow["kind"] });
    if (c.account === r.account && c.description === r.description && c.merchant === r.merchant && c.symbol === r.symbol) continue;
    let n = 1;
    while (taken.get(r.space_id, fingerprintOf(c, n), r.id)) n++;
    put.run(c.account, c.description, c.merchant, c.symbol, fingerprintOf(c, n), r.id);
    changed = true;
  }
  mark(top);
  return changed;
}
