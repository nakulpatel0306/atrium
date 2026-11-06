import type { Database } from "bun:sqlite";
import { bus } from "../events";
import { setSetting } from "../settings";

// Plan 7's tools (look-through, TFSA, ideas, paper, strategies, indicator alerts, the data budget) sit behind one
// per-space switch. Off is the default: their data stays, and their background work stops while no space has it on.
export const advancedKey = (spaceId: string): string => `markets.advanced.${spaceId}`;

export function isAdvanced(db: Database, spaceId: string): boolean {
  const row = db.query("SELECT value FROM settings WHERE key = ?").get(advancedKey(spaceId)) as { value: string } | null;
  return row?.value === "on";
}

export function setAdvanced(db: Database, spaceId: string, on: boolean): void {
  if (on) return setSetting(db, advancedKey(spaceId), "on");
  const gone = db.query("DELETE FROM settings WHERE key = ?").run(advancedKey(spaceId));
  if (gone.changes) bus.emit({ type: "changed" });
}

export function advancedSpaces(db: Database): Set<string> {
  const rows = db
    .query("SELECT s.id FROM spaces s JOIN settings t ON t.key = 'markets.advanced.' || s.id WHERE s.kind = 'markets' AND s.status = 'active' AND t.value = 'on'")
    .all() as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

export const anyAdvanced = (db: Database): boolean => advancedSpaces(db).size > 0;

export function bigNewsArmed(db: Database): boolean {
  return !!db
    .query(
      `SELECT 1 FROM market_alerts a JOIN spaces s ON s.id = a.space_id
       WHERE a.status != 'off' AND s.status = 'active' AND s.kind = 'markets' AND a.rule LIKE '%"kind":"big_news"%' LIMIT 1`,
    )
    .get();
}

export const isIndicatorRule = (kind: string): boolean => kind.startsWith("rsi") || kind.startsWith("cross");
