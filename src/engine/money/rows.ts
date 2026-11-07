import type { Database } from "bun:sqlite";
import { categorize, NOT_SPENDING, type Rule } from "./categories";
import { transfers } from "./transfers";

export type Tx = { id: string; date: string; account: string; description: string; merchant: string; amount: number; currency: string; kind: string; source: string; transfer: number | null };

export const txs = (db: Database, spaceId: string, source: "bank" | "wealthsimple") =>
  db
    .query("SELECT id, date, account, description, merchant, amount, currency, kind, source, transfer FROM money_transactions WHERE space_id = ? AND source = ? ORDER BY date, rowid")
    .all(spaceId, source) as Tx[];

// Bank and card rows with transfers between Nakul's own accounts taken out: what spending and money in count.
export function counted(bank: Tx[]): Tx[] {
  const moved = transfers(bank);
  return bank.filter((t) => !moved.has(t.id));
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// One month of counted rows by category: spending (charges, minus transfers and money in) and money in.
export function spendingIn(bank: Tx[], month: string | null, rules: Rule[]) {
  const inMonth = month ? bank.filter((t) => t.date.startsWith(month)) : [];
  const cats = new Map<string, { amount: number; count: number }>();
  let income = 0;
  for (const t of inMonth) {
    const category = categorize(t.description, rules);
    if (t.amount > 0 && category !== "Transfers") income += t.amount;
    if (t.amount >= 0 || NOT_SPENDING.has(category)) continue;
    const c = cats.get(category) ?? { amount: 0, count: 0 };
    cats.set(category, { amount: c.amount - t.amount, count: c.count + 1 });
  }
  const spending = [...cats.entries()].map(([category, c]) => ({ category, amount: round2(c.amount), count: c.count })).sort((a, b) => b.amount - a.amount);
  return { spending, spent: round2(spending.reduce((s, c) => s + c.amount, 0)), income: round2(income) };
}
