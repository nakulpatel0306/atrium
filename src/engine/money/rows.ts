import type { Database } from "bun:sqlite";
import { categorize, NOT_SPENDING, type Rule } from "./categories";
import { CARD_BILL, E_TRANSFER, isCard, type Flow } from "./flows";
import { transfers } from "./transfers";

export type Tx = { id: string; date: string; account: string; description: string; merchant: string; amount: number; currency: string; kind: string; source: string; transfer: number | null; flow: Flow | null };

export const txs = (db: Database, spaceId: string, source: "bank" | "wealthsimple") =>
  db
    .query("SELECT id, date, account, description, merchant, amount, currency, kind, source, transfer, flow FROM money_transactions WHERE space_id = ? AND source = ? ORDER BY date, rowid")
    .all(spaceId, source) as Tx[];

// Bank and card rows with transfers between Nakul's own accounts taken out: what spending and money in count.
export function counted(bank: Tx[]): Tx[] {
  const moved = transfers(bank);
  return bank.filter((t) => !moved.has(t.id));
}

export const E_TRANSFERS = "E-transfers";

// How a counted row adds up. A credit on a card is a refund, never money in, even when he said a card payment isn't
// a transfer. Money in is pay, interest and e-transfers received; other Transfers-category credits stay out.
// An e-transfer sent to someone else is spending (those between his own accounts were taken out as moved), and
// is also named on the recap; any other Transfers-category charge isn't.
export type Counts = { as: "spend" | "refund" | "income" | "none"; category: string; sent?: true };
export function countAs(t: Tx, rules: Rule[]): Counts {
  const named = categorize(t.description, rules);
  if (t.amount > 0) {
    if (isCard(t.account)) return { as: "refund", category: NOT_SPENDING.has(named) ? "Other" : named };
    return { as: named === "Transfers" && !E_TRANSFER.test(t.description) ? "none" : "income", category: named };
  }
  if (t.amount === 0) return { as: "none", category: named };
  if (t.flow === "card-bill" || t.flow === "card-paid") return { as: "spend", category: CARD_BILL };
  if (E_TRANSFER.test(t.description)) return { as: "spend", category: NOT_SPENDING.has(named) ? E_TRANSFERS : named, sent: true };
  return { as: NOT_SPENDING.has(named) ? "none" : "spend", category: named };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export type MonthTotals = {
  spending: { category: string; amount: number; count: number }[];
  spent: number;
  income: number;
  refunds: { count: number; total: number };
  // Interac e-transfers sent to other people: in spending, and said aloud, since rent paid that way has no merchant.
  sent: { count: number; total: number };
};

// One month of counted rows by category: spending (charges less refunds; a category refunded more than it was
// charged this month stops at zero) and money in.
export function spendingIn(bank: Tx[], month: string | null, rules: Rule[]): MonthTotals {
  const inMonth = month ? bank.filter((t) => t.date.startsWith(month)) : [];
  const cats = new Map<string, { amount: number; count: number }>();
  const refunds = { count: 0, total: 0 };
  const sent = { count: 0, total: 0 };
  let income = 0;
  for (const t of inMonth) {
    const c = countAs(t, rules);
    if (c.sent) {
      sent.count++;
      sent.total -= t.amount;
    }
    if (c.as === "income") income += t.amount;
    else if (c.as === "spend" || c.as === "refund") {
      if (c.as === "refund") {
        refunds.count++;
        refunds.total += t.amount;
      }
      const prev = cats.get(c.category) ?? { amount: 0, count: 0 };
      cats.set(c.category, { amount: prev.amount - t.amount, count: prev.count + (c.as === "spend" ? 1 : 0) });
    }
  }
  const spending = [...cats.entries()]
    .filter(([, c]) => c.count > 0 && c.amount > 0.005)
    .map(([category, c]) => ({ category, amount: round2(c.amount), count: c.count }))
    .sort((a, b) => b.amount - a.amount);
  return {
    spending,
    spent: round2(spending.reduce((s, c) => s + c.amount, 0)),
    income: round2(income),
    refunds: { count: refunds.count, total: round2(refunds.total) },
    sent: { count: sent.count, total: round2(sent.total) },
  };
}

// Money moved between his own accounts in a month, from all rows: how many rows were left out, and the total counted
// once, from whichever side carries more of it (the paying side, unless only the card's file is imported).
export function movedIn(all: Tx[], month: string): { count: number; total: number } {
  const moved = transfers(all);
  const rows = all.filter((t) => t.date.startsWith(month) && moved.has(t.id));
  const out = rows.filter((t) => t.amount < 0).reduce((s, t) => s - t.amount, 0);
  const into = rows.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  return { count: rows.length, total: round2(Math.max(out, into)) };
}
