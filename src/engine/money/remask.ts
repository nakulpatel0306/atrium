import type { Database } from "bun:sqlite";
import { fingerprintOf, legacyMask, maskNumbers, storeRow, type MoneyRow } from "./import";

// The highest row already checked; rows written after it (by anything but today's importer) are checked on next open.
const REMASK_KEY = "money.remaskedThrough";

type Row = { id: string; space_id: string; source: "bank" | "wealthsimple"; account: string; date: string; description: string; merchant: string; amount: number; currency: "CAD" | "USD"; kind: string; symbol: string | null };

// Once: every money row stored by an earlier masker goes through today's, fingerprints are rebuilt from the masked
// rows, and a row the old masker stored with a date hidden ("UBER TRIP ··1001") is dropped when the same transaction
// is also here with its date ("UBER TRIP 2026-10-01"). Import records, reminders, budgets and rules are re-masked too.
// Safe to run again and on an empty table. Later opens only re-check rows added since.
export function remaskMoney(db: Database): void {
  const done = db.query("SELECT value FROM settings WHERE key = ?").get(REMASK_KEY) as { value: string } | null;
  const top = (db.query("SELECT COALESCE(MAX(rowid), 0) AS n FROM money_transactions").get() as { n: number }).n;
  const mark = (n: number) => db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(REMASK_KEY, String(n));
  if (done) {
    const since = Number(done.value);
    if (top > since) db.transaction(() => recheck(db, since, top, mark))();
    return;
  }
  db.transaction(() => {
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

    for (const t of ["money_imports"]) {
      for (const r of db.query(`SELECT id, account FROM ${t}`).all() as { id: string; account: string }[]) {
        const account = maskNumbers(r.account);
        if (account !== r.account) db.query(`UPDATE ${t} SET account = ? WHERE id = ?`).run(account, r.id);
      }
    }
    for (const r of db.query("SELECT id, title, body FROM money_nudges").all() as { id: string; title: string; body: string }[]) {
      db.query("UPDATE money_nudges SET title = ?, body = ? WHERE id = ?").run(maskNumbers(r.title), maskNumbers(r.body), r.id);
    }
    for (const r of db.query("SELECT space_id, category FROM money_budgets").all() as { space_id: string; category: string }[]) {
      const category = maskNumbers(r.category);
      if (category !== r.category) db.query("UPDATE OR IGNORE money_budgets SET category = ? WHERE space_id = ? AND category = ?").run(category, r.space_id, r.category);
    }
    for (const r of db.query("SELECT key, value FROM settings WHERE key LIKE 'money.rules.%'").all() as { key: string; value: string }[]) {
      const value = maskNumbers(r.value);
      if (value !== r.value) db.query("UPDATE settings SET value = ? WHERE key = ?").run(value, r.key);
    }
    mark(top);
  })();
}

// Rows added since the last check: masked again where they need it, with a fresh fingerprint.
function recheck(db: Database, since: number, top: number, mark: (n: number) => void): void {
  const rows = db.query("SELECT id, space_id, source, account, date, description, merchant, amount, currency, kind, symbol FROM money_transactions WHERE rowid > ? AND rowid <= ?").all(since, top) as Row[];
  const taken = db.query("SELECT 1 FROM money_transactions WHERE space_id = ? AND fingerprint = ? AND id != ?");
  const put = db.query("UPDATE money_transactions SET account = ?, description = ?, merchant = ?, symbol = ?, fingerprint = ? WHERE id = ?");
  for (const r of rows) {
    const c = storeRow({ ...r, kind: r.kind as MoneyRow["kind"] });
    if (c.account === r.account && c.description === r.description && c.merchant === r.merchant && c.symbol === r.symbol) continue;
    let n = 1;
    while (taken.get(r.space_id, fingerprintOf(c, n), r.id)) n++;
    put.run(c.account, c.description, c.merchant, c.symbol, fingerprintOf(c, n), r.id);
  }
  mark(top);
}
