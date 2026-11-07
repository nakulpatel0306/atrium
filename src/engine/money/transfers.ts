import type { Database } from "bun:sqlite";
import { bus } from "../events";

// Money moving between Nakul's own accounts (paying the Amex from TD, topping up Wealthsimple Cash) is neither
// spending nor money in. His own mark always wins; otherwise a known description, or the same amount leaving one
// account and arriving in another within 3 days.
export type TransferWhy = "marked" | "known" | "pair";
export type TransferTx = { id: string; date: string; account: string; description: string; amount: number; kind: string; transfer: number | null };

const PAIR_DAYS = 3;
const DAY_MS = 86_400_000;
// Descriptions that name a payment or top-up between accounts. One that names a bank only counts when an account at
// that bank is among his imports; the card's own "thank you" line needs a second account of his to come from.
const KNOWN: { re: RegExp; bank: RegExp | null }[] = [
  { re: /\bamex\b.*\b(payment|pymt|pmt)\b/i, bank: /amex/i },
  { re: /wealthsimple|\bws investments\b/i, bank: /wealthsimple/i },
  { re: /td visa (preauth|pymt|payment)/i, bank: /\btd\b/i },
  { re: /transfer (in|out) (from|to) td\b/i, bank: /\btd\b/i },
  { re: /transfer (in|out) (from|to) amex\b/i, bank: /amex/i },
  { re: /transfer (in|out) (from|to) wealthsimple\b/i, bank: /wealthsimple/i },
  { re: /payment\s*-?\s*thank you|payment received/i, bank: null },
];
const E_TRANSFER = /e-?\s?transfer|e-?tfr|e-?trf|interac/i;

const known = (t: Pick<TransferTx, "description" | "account">, accounts: string[]) => {
  const others = accounts.filter((a) => a !== t.account);
  return KNOWN.some((k) => k.re.test(t.description) && (k.bank ? others.some((a) => k.bank!.test(a)) : others.length > 0));
};

// For the transactions list and tests: a description that would count, given his accounts.
export const isKnownTransfer = (t: Pick<TransferTx, "description" | "kind" | "account">, accounts: string[]): boolean => t.kind === "transfer" || known(t, accounts);

const dayOf = (date: string) => Date.parse(`${date}T12:00:00Z`) / DAY_MS;

export function transfers(rows: TransferTx[]): Map<string, TransferWhy> {
  const accounts = [...new Set(rows.map((t) => t.account))];
  const out = new Map<string, TransferWhy>();
  const shaped = new Set<string>();
  for (const t of rows) {
    const k = isKnownTransfer(t, accounts);
    if (k) shaped.add(t.id);
    if (t.transfer === 1) out.set(t.id, "marked");
    else if (t.transfer === null && k) out.set(t.id, "known");
  }
  // An Interac e-transfer can be to or from anyone, so it pairs only with a row that is itself a transfer between
  // his accounts: a friend paying him back for dinner doesn't cancel the dinner.
  const pairable = (a: TransferTx, b: TransferTx) => {
    const eA = E_TRANSFER.test(a.description);
    const eB = E_TRANSFER.test(b.description);
    if (!eA && !eB) return true;
    return (eA || shaped.has(a.id)) && (eB || shaped.has(b.id)) && (shaped.has(a.id) || shaped.has(b.id));
  };
  // Pairs, nearest date first; rows he marked as not a transfer never pair, and each row pairs once.
  const incoming = new Map<number, TransferTx[]>();
  for (const t of rows) {
    if (t.amount <= 0 || t.transfer === 0) continue;
    const cents = Math.round(t.amount * 100);
    const list = incoming.get(cents);
    if (list) list.push(t);
    else incoming.set(cents, [t]);
  }
  const used = new Set<string>();
  for (const t of rows) {
    if (t.amount >= 0 || t.transfer === 0) continue;
    const candidates = (incoming.get(Math.round(-t.amount * 100)) ?? []).filter(
      (c) => !used.has(c.id) && c.account !== t.account && Math.abs(dayOf(c.date) - dayOf(t.date)) <= PAIR_DAYS && pairable(t, c),
    );
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
