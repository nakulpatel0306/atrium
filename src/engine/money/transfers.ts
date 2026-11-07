import type { Database } from "bun:sqlite";
import { bus } from "../events";

// Money moving between Nakul's own accounts (paying the Amex from TD, topping up Wealthsimple Cash) is neither
// spending nor money in. His own mark always wins; otherwise a known description, or the same amount leaving one
// account and arriving in another within 3 days.
export type TransferWhy = "marked" | "known" | "pair";
export type TransferTx = { id: string; date: string; account: string; description: string; amount: number; kind: string; transfer: number | null };

const PAIR_DAYS = 3;
const DAY_MS = 86_400_000;
const KNOWN = [
  /\bamex\b.*\b(payment|pymt|pmt)\b/i,
  /payment\s*-?\s*thank you/i,
  /payment received/i,
  /wealthsimple/i,
  /\bws investments\b/i,
  /td visa (preauth|pymt|payment)/i,
  /transfer (in|out) (from|to) (td|amex|wealthsimple)/i,
];

export const isKnownTransfer = (t: Pick<TransferTx, "description" | "kind">): boolean => t.kind === "transfer" || KNOWN.some((re) => re.test(t.description));

const dayOf = (date: string) => Date.parse(`${date}T12:00:00Z`) / DAY_MS;

export function transfers(rows: TransferTx[]): Map<string, TransferWhy> {
  const out = new Map<string, TransferWhy>();
  for (const t of rows) {
    if (t.transfer === 1) out.set(t.id, "marked");
    else if (t.transfer === null && isKnownTransfer(t)) out.set(t.id, "known");
  }
  // Pairs, nearest date first; rows he marked as not a transfer never pair, and each row pairs once.
  const incoming = new Map<number, TransferTx[]>();
  for (const t of rows) {
    if (t.amount <= 0 || t.transfer === 0) continue;
    const cents = Math.round(t.amount * 100);
    incoming.set(cents, [...(incoming.get(cents) ?? []), t]);
  }
  const used = new Set<string>();
  for (const t of rows) {
    if (t.amount >= 0 || t.transfer === 0) continue;
    const candidates = (incoming.get(Math.round(-t.amount * 100)) ?? []).filter((c) => !used.has(c.id) && c.account !== t.account && Math.abs(dayOf(c.date) - dayOf(t.date)) <= PAIR_DAYS);
    const match = candidates.sort((a, b) => Math.abs(dayOf(a.date) - dayOf(t.date)) - Math.abs(dayOf(b.date) - dayOf(t.date)))[0];
    if (!match) continue;
    used.add(match.id);
    if (!out.has(t.id)) out.set(t.id, "pair");
    if (!out.has(match.id)) out.set(match.id, "pair");
  }
  return out;
}

// true or false is Nakul's say; null hands it back to Atrium.
export function markTransfer(db: Database, spaceId: string, id: string, value: boolean | null): void {
  const res = db.query("UPDATE money_transactions SET transfer = ? WHERE id = ? AND space_id = ?").run(value === null ? null : value ? 1 : 0, id, spaceId);
  if (!res.changes) throw new Error("That transaction isn't here anymore. Refresh the page.");
  bus.emit({ type: "changed" });
}
