import type { Database } from "bun:sqlite";
import { bus } from "../events";
import { listTasks } from "../tasks";
import { ACCOUNTS, OTHER_ACCOUNT } from "./banks";
import { fingerprintOf, normalDescription, twinCounter, type MoneyRow } from "./import";

// Each import Nakul did, with the rows it added, so a wrong one can be undone or moved to the right account.
export type ImportRow = { id: string; account: string; from: string; to: string; rows: number; importedAt: number };

export const GONE = "That import isn't here anymore. Refresh the page.";
export const BUSY = "Claude is looking at your money. Try again when it's done.";

type Logged = { id: string; space_id: string; account: string };
type Stored = { id: string; source: MoneyRow["source"]; account: string; date: string; description: string; amount: number; currency: MoneyRow["currency"] };

export function listImports(db: Database, spaceId: string): ImportRow[] {
  return db
    .query(
      `SELECT i.id, i.account, i.first_date AS "from", i.last_date AS "to", i.imported_at AS importedAt,
         (SELECT COUNT(*) FROM money_transactions t WHERE t.import_id = i.id) AS rows
       FROM money_imports i WHERE i.space_id = ? ORDER BY i.imported_at DESC, i.rowid DESC`,
    )
    .all(spaceId) as ImportRow[];
}

// The accounts an import can move to: his named ones, and any other he has rows in.
export function knownAccounts(db: Database, spaceId: string): string[] {
  const stored = (db.query("SELECT DISTINCT account FROM money_transactions WHERE space_id = ? AND source = 'bank' ORDER BY account").all(spaceId) as { account: string }[]).map((r) => r.account);
  return [...new Set([...ACCOUNTS, ...stored])].filter((a) => a !== OTHER_ACCOUNT);
}

export const moneyBusy = (db: Database, spaceId: string): boolean => listTasks(db, { spaceId, status: ["queued", "running"] }).some((t) => t.purpose === "money");

export const findImport = (db: Database, id: string): Logged | null => db.query("SELECT id, space_id, account FROM money_imports WHERE id = ?").get(id) as Logged | null;

function logged(db: Database, id: string): Logged {
  const imp = findImport(db, id);
  if (!imp) throw new Error(GONE);
  // Claude's money run reads these rows; changing them under it would make its answer about data that's gone.
  if (moneyBusy(db, imp.space_id)) throw new Error(BUSY);
  return imp;
}

// Deletes exactly the rows this import added, and its record, so coverage forgets it too.
export function undoImport(db: Database, id: string): { removed: number } {
  logged(db, id);
  const removed = db.transaction(() => {
    const n = db.query("DELETE FROM money_transactions WHERE import_id = ?").run(id).changes;
    db.query("DELETE FROM money_imports WHERE id = ?").run(id);
    return n;
  })();
  bus.emit({ type: "changed" });
  return { removed };
}

// Moves an import's rows to another of his accounts. Fingerprints are rebuilt for it, and a row that the account
// already holds from another import is dropped; identical rows within the import all stay.
export function changeImportAccount(db: Database, id: string, account: string): { moved: number; dropped: number } {
  const imp = logged(db, id);
  if (!knownAccounts(db, imp.space_id).includes(account)) throw new Error("Pick one of your accounts.");
  const others = twinCounter(db);
  const taken = db.query("SELECT 1 FROM money_transactions WHERE space_id = ? AND fingerprint = ? AND id != ?");
  const put = db.query("UPDATE money_transactions SET account = ?, fingerprint = ? WHERE id = ?");
  const del = db.query("DELETE FROM money_transactions WHERE id = ?");
  let moved = 0;
  let dropped = 0;
  db.transaction(() => {
    const rows = db.query("SELECT id, source, account, date, description, amount, currency FROM money_transactions WHERE import_id = ? ORDER BY rowid").all(id) as Stored[];
    const seen = new Map<string, number>();
    for (const row of rows) {
      const r = { ...row, account };
      const key = `${r.source}|${r.date}|${r.amount.toFixed(2)}|${r.currency}|${normalDescription(r.description)}`;
      const k = (seen.get(key) ?? 0) + 1;
      seen.set(key, k);
      if (others(imp.space_id, { ...r, merchant: "", kind: "other", symbol: null }, id) >= k) {
        del.run(r.id);
        dropped++;
        continue;
      }
      let n = 1;
      while (taken.get(imp.space_id, fingerprintOf(r, n), r.id)) n++;
      put.run(account, fingerprintOf(r, n), r.id);
      moved++;
    }
    db.query("UPDATE money_imports SET account = ? WHERE id = ?").run(account, id);
  })();
  bus.emit({ type: "changed" });
  return { moved, dropped };
}
