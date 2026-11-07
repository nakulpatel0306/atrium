import type { Database } from "bun:sqlite";
import { bus } from "../events";
import { newId } from "../ids";
import { listSpaces } from "../spaces";
import { maskNumbers } from "./import";

// Calm heads-ups from Money: a budget reaching 80% or 100%, and the monthly "time to import" reminder. They aren't
// approvals and don't add to the badge; the Mac app notifies once per new id. The key is unique per space, so each
// one is sent once however often it's checked.
export type NudgeKind = "budget" | "import";
export type Nudge = { id: string; spaceId: string; spaceName: string; kind: NudgeKind; title: string; body: string; path: string; createdAt: number };

// A budget heads-up is only news for a couple of days; the import reminder stays until it's done or dismissed.
const BUDGET_SHOWN_MS = 2 * 86_400_000;

export const moneyPath = (spaceId: string) => `/space/${spaceId}?tab=money`;

// Titles and bodies are masked here too, so nothing that reaches a notification can carry a card number.
export function addNudge(db: Database, spaceId: string, kind: NudgeKind, key: string, title: string, body: string, now: number): boolean {
  const added = db
    .query("INSERT OR IGNORE INTO money_nudges (id, space_id, kind, key, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(newId("mnd"), spaceId, kind, key, maskNumbers(title), maskNumbers(body), now).changes;
  if (added) bus.emit({ type: "changed" });
  return added > 0;
}

export function hasNudge(db: Database, spaceId: string, key: string): boolean {
  return !!db.query("SELECT 1 FROM money_nudges WHERE space_id = ? AND key = ?").get(spaceId, key);
}

// Done for good: dismissed by Nakul, or the thing it asked for happened.
export function settleNudge(db: Database, spaceId: string, key: string, now: number): void {
  if (db.query("UPDATE money_nudges SET dismissed_at = ? WHERE space_id = ? AND key = ? AND dismissed_at IS NULL").run(now, spaceId, key).changes) bus.emit({ type: "changed" });
}

export function dismissNudge(db: Database, id: string, now: number): void {
  if (!db.query("UPDATE money_nudges SET dismissed_at = ? WHERE id = ? AND dismissed_at IS NULL").run(now, id).changes) {
    throw new Error("That reminder is already gone. Refresh the page.");
  }
  bus.emit({ type: "changed" });
}

type Row = { id: string; space_id: string; kind: NudgeKind; title: string; body: string; created_at: number };

export function activeNudges(db: Database, now: number): Nudge[] {
  const names = new Map(listSpaces(db).map((s) => [s.id, s.name]));
  const rows = db
    .query("SELECT id, space_id, kind, title, body, created_at FROM money_nudges WHERE dismissed_at IS NULL AND (kind = 'import' OR created_at > ?) ORDER BY created_at DESC")
    .all(now - BUDGET_SHOWN_MS) as Row[];
  return rows
    .filter((r) => names.has(r.space_id))
    .map((r) => ({ id: r.id, spaceId: r.space_id, spaceName: names.get(r.space_id)!, kind: r.kind, title: r.title, body: r.body, path: moneyPath(r.space_id), createdAt: r.created_at }));
}
