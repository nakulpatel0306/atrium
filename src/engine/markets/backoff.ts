import type { Database } from "bun:sqlite";

// A symbol whose Finnhub call keeps failing (a sustained per-symbol error) sits out this long, so it neither blocks
// the symbols after it nor brings its job back every hour.
export const SYMBOL_BACKOFF_MS = 6 * 3_600_000;

const key = (name: string) => `markets.backoff.${name}`;
const read = (db: Database, name: string): Record<string, number> => {
  const raw = (db.query("SELECT value FROM settings WHERE key = ?").get(key(name)) as { value: string } | null)?.value;
  return raw ? (JSON.parse(raw) as Record<string, number>) : {};
};

// Written directly (no `changed`): it's bookkeeping. Expired entries are dropped on each write.
export function backOff(db: Database, name: string, symbols: string[], now: number): void {
  const cur = Object.fromEntries(Object.entries(read(db, name)).filter(([, until]) => until > now));
  for (const s of symbols) cur[s] = now + SYMBOL_BACKOFF_MS;
  db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key(name), JSON.stringify(cur));
}

export const backedOff = (db: Database, name: string, now: number): Set<string> =>
  new Set(Object.entries(read(db, name)).flatMap(([s, until]) => (until > now ? [s] : [])));
