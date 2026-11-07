import type { Database } from "bun:sqlite";
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
