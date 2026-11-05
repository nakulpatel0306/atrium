import type { Database } from "bun:sqlite";
import { etDate } from "./calendar";

// Counted per ET date in the settings table. Written directly rather than through setSetting so a spend doesn't
// emit `changed` and wake every listener for a counter nobody displays live.
export function dailyBudget(db: Database, name: string, limit: number, now: () => number): { remaining(): number; spend(): boolean } {
  const prefix = `markets.budget.${name}.`;
  const used = () => {
    const row = db.query("SELECT value FROM settings WHERE key = ?").get(prefix + etDate(now())) as { value: string } | null;
    return row ? Number(row.value) : 0;
  };
  return {
    remaining: () => Math.max(0, limit - used()),
    spend() {
      const n = used();
      if (n >= limit) return false;
      const key = prefix + etDate(now());
      db.transaction(() => {
        db.query("DELETE FROM settings WHERE key LIKE ? AND key != ?").run(`${prefix}%`, key);
        db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(n + 1));
      })();
      return true;
    },
  };
}
