import type { Database } from "bun:sqlite";
import { bus } from "../events";
import { etDate } from "../markets/calendar";
import { listRules } from "./categories";
import { maskNumbers } from "./import";
import { shiftMonth } from "./coverage";
import { addNudge, hasNudge } from "./nudges";
import { monthName } from "./recap";
import { counted, spendingIn, txs } from "./rows";

// Optional monthly limits per category, kept per space. A heads-up goes out once at 80% and once at 100% for each
// category and month: this month, and last month too, since Nakul imports after a month ends.
export type Budget = { category: string; limit: number };
export type BudgetRow = Budget & { spent: number; pct: number };

const MAX_LIMIT = 1_000_000;
const MAX_CATEGORY = 30;
const cad = (n: number) => `CA$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function listBudgets(db: Database, spaceId: string): Budget[] {
  return db.query("SELECT category, monthly_limit AS \"limit\" FROM money_budgets WHERE space_id = ? ORDER BY category").all(spaceId) as Budget[];
}

// A limit of null (or 0) removes the budget.
export function setBudget(db: Database, spaceId: string, category: string, limit: number | null): void {
  const c = maskNumbers(category.trim());
  if (!c || c.length > MAX_CATEGORY) throw new Error("Pick a category for this budget.");
  if (limit === null || limit === 0) db.query("DELETE FROM money_budgets WHERE space_id = ? AND category = ?").run(spaceId, c);
  else {
    if (!Number.isFinite(limit) || limit < 0 || limit > MAX_LIMIT) throw new Error("Use an amount like 400.");
    db.query(
      "INSERT INTO money_budgets (space_id, category, monthly_limit, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(space_id, category) DO UPDATE SET monthly_limit = excluded.monthly_limit, updated_at = excluded.updated_at",
    ).run(spaceId, c, Math.round(limit * 100) / 100, Date.now());
  }
  bus.emit({ type: "changed" });
}

export function budgetRows(budgets: Budget[], spending: { category: string; amount: number }[]): BudgetRow[] {
  return budgets.map((b) => {
    const spent = spending.find((s) => s.category === b.category)?.amount ?? 0;
    // Rounded down, so 79.6% doesn't read as 80% and send the heads-up early.
    return { ...b, spent, pct: b.limit > 0 ? Math.floor((spent / b.limit) * 100) : 0 };
  });
}

export function checkBudgets(db: Database, spaceId: string, now: number): number {
  const budgets = listBudgets(db, spaceId);
  if (!budgets.length) return 0;
  const rows = counted(txs(db, spaceId, "bank"));
  const rules = listRules(db, spaceId);
  const current = etDate(now).slice(0, 7);
  let sent = 0;
  for (const month of [shiftMonth(current, -1), current]) {
    const { spending } = spendingIn(rows, month, rules);
    for (const b of budgetRows(budgets, spending)) {
      const key = (level: number) => `budget:${month}:${b.category}:${level}`;
      const name = monthName(month);
      const body = `${cad(b.spent)} of ${cad(b.limit)} in ${name}.`;
      // Crossing both at once sends only the 100% one, and 80% never follows it.
      if (b.pct >= 100 && !hasNudge(db, spaceId, key(100))) {
        sent += +addNudge(db, spaceId, "budget", key(100), `${b.category} reached its ${name} budget`, body, now);
      } else if (b.pct >= 80 && b.pct < 100 && !hasNudge(db, spaceId, key(80)) && !hasNudge(db, spaceId, key(100))) {
        sent += +addNudge(db, spaceId, "budget", key(80), `${b.category} is at ${b.pct}% of its ${name} budget`, body, now);
      }
    }
  }
  return sent;
}
