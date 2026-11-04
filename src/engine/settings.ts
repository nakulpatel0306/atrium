import type { Database } from "bun:sqlite";
import { bus } from "./events";

export function getSetting(db: Database, key: string): string | null {
  const row = db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null;
  return row ? row.value : null;
}

// Unchanged writes stay silent: the runner writes settings every tick, and a
// `changed` per write would wake the runner again in a loop.
export function setSetting(db: Database, key: string, value: string): void {
  if (getSetting(db, key) === value) return;
  db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    value,
  );
  bus.emit({ type: "changed" });
}
