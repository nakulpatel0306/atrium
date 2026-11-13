import type { Database } from "bun:sqlite";
import { bus } from "./events";
import { hasKeychainItem, removeKeychainItem } from "./keychain";
import { LEGACY, present } from "./legacy";
import type { OldData } from "./old-data-view";

// Home's notice was put off ("Not now"); Settings → Data still offers the removal.
export const OLD_DATA_DISMISSED = "notice.oldData.dismissed";

// GLOB, not LIKE: a prefix match that respects case, so "Mail.x" never reads as a "mail." setting.
const prefixMatch = (): string => LEGACY.settingsPrefixes.map(() => "key GLOB ?").join(" OR ");
const prefixArgs = (): string[] => LEGACY.settingsPrefixes.map((p) => `${p}*`);
const removedKinds = (): string =>
  `kind IN (${LEGACY.approvalKinds.map((k) => `'${k}'`).join(",")}) OR always_ask IN (${LEGACY.alwaysAsk.map((k) => `'${k}'`).join(",")})`;

function presentTables(db: Database): OldData["groups"] {
  return LEGACY.tables
    .map((g) => ({
      label: g.label,
      tables: g.names.filter((n) => present(db, n)).map((name) => ({ name, rows: (db.query(`SELECT COUNT(*) AS n FROM ${name}`).get() as { n: number }).n })),
    }))
    .filter((g) => g.tables.length > 0);
}

// Cheap enough for every snapshot: no Keychain lookup. Every older install made the tables, so they stand in for
// the Keychain items it may also hold.
export function hasOldData(db: Database): boolean {
  if (LEGACY.tables.some((g) => g.names.some((n) => present(db, n)))) return true;
  if (db.query(`SELECT 1 FROM settings WHERE ${prefixMatch()} LIMIT 1`).get(...prefixArgs())) return true;
  return !!db.query(`SELECT 1 FROM approvals WHERE ${removedKinds()} LIMIT 1`).get();
}

function keychainAccounts(db: Database): string[] {
  const google = present(db, "mail_accounts") ? (db.query("SELECT id FROM mail_accounts ORDER BY id").all() as { id: string }[]).map((r) => `${LEGACY.googleRefresh}${r.id}`) : [];
  return [...google, ...LEGACY.keychain];
}

// Null when there's nothing left. Lists only the Keychain items that are actually there.
export async function findOldData(db: Database): Promise<OldData | null> {
  if (!hasOldData(db)) return null;
  const keychain: string[] = [];
  for (const account of keychainAccounts(db)) if (await hasKeychainItem(account)) keychain.push(account);
  return {
    groups: presentTables(db),
    settings: (db.query(`SELECT key FROM settings WHERE ${prefixMatch()} ORDER BY key`).all(...prefixArgs()) as { key: string }[]).map((r) => r.key),
    approvals: (db.query(`SELECT COUNT(*) AS n FROM approvals WHERE ${removedKinds()}`).get() as { n: number }).n,
    keychain,
    spaces: (db.query("SELECT name FROM spaces WHERE kind NOT IN ('repo','general') ORDER BY created_at").all() as { name: string }[]).map((r) => r.name),
  };
}

// Keychain items go first, while mail_accounts still names the Google ones: if the Keychain refuses, nothing in the
// database has gone and the user can try again. Then the tables are dropped and the file is rewritten, so no copy
// of the old rows stays in free pages or the WAL.
export async function removeOldData(db: Database): Promise<OldData | null> {
  const found = await findOldData(db);
  if (!found) return null;
  for (const account of found.keychain) await removeKeychainItem(account);
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.transaction(() => {
      for (const g of found.groups) for (const t of g.tables) db.exec(`DROP TABLE ${t.name}`);
      db.query(`DELETE FROM settings WHERE ${prefixMatch()}`).run(...prefixArgs());
      const ids = (db.query(`SELECT id FROM approvals WHERE ${removedKinds()}`).all() as { id: string }[]).map((r) => r.id);
      if (ids.length) {
        const marks = ids.map(() => "?").join(",");
        db.query(`UPDATE tasks SET approval_id = NULL WHERE approval_id IN (${marks})`).run(...ids);
        db.query(`DELETE FROM approvals WHERE id IN (${marks})`).run(...ids);
      }
    })();
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.exec("VACUUM");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  bus.emit({ type: "changed" });
  return found;
}
