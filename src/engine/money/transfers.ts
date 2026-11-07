import type { Database } from "bun:sqlite";
import { bus } from "../events";
import { E_TRANSFER, MOVED_FLOWS, reflowMoney, type Flow } from "./flows";

// Money moving between Nakul's own accounts (paying the Amex from TD, topping up Wealthsimple savings) is neither
// spending nor money in. His own mark always wins; otherwise a card payment or bank transfer Atrium stored (see
// flows.ts), a known description, or the same amount leaving one account and arriving in another within 3 days.
export type TransferWhy = "marked" | "card-payment" | "card-paid" | "own" | "known" | "pair";
export type TransferTx = { id: string; date: string; account: string; description: string; amount: number; kind: string; transfer: number | null; flow?: Flow | null };

// A pair with a known transfer description on either side may be up to 3 days apart; any other same-amount pair
// only within a day.
const PAIR_DAYS = 3;
const PLAIN_PAIR_DAYS = 1;
const DAY_MS = 86_400_000;
// Descriptions that name a top-up between accounts. One that names a bank only counts when an account at that bank
// is among his imports. Card payments are decided in flows.ts.
const KNOWN: { re: RegExp; bank: RegExp }[] = [
  { re: /wealthsimple|\bws investments\b/i, bank: /wealthsimple/i },
  { re: /transfer (in|out) (from|to) td\b/i, bank: /\btd\b/i },
  { re: /transfer (in|out) (from|to) amex\b/i, bank: /amex/i },
  { re: /transfer (in|out) (from|to) wealthsimple\b/i, bank: /wealthsimple/i },
];

const known = (t: Pick<TransferTx, "description" | "account">, accounts: string[]) => {
  const others = accounts.filter((a) => a !== t.account);
  return KNOWN.some((k) => k.re.test(t.description) && others.some((a) => k.bank.test(a)));
};

// Why Atrium would call a row a transfer on its own, before his mark and before pairs.
function shapeOf(t: TransferTx, accounts: string[]): TransferWhy | null {
  const flow = t.flow ?? null;
  if (flow === "card-payment" || flow === "card-paid") return flow;
  if (flow === "moved" && E_TRANSFER.test(t.description)) return "own";
  if (flow === "moved" || t.kind === "transfer" || (flow === null && known(t, accounts))) return "known";
  return null;
}

const dayOf = (date: string) => Date.parse(`${date}T12:00:00Z`) / DAY_MS;

export function transfers(rows: TransferTx[]): Map<string, TransferWhy> {
  const accounts = [...new Set(rows.map((t) => t.account))];
  const out = new Map<string, TransferWhy>();
  const shaped = new Set<string>();
  for (const t of rows) {
    const why = shapeOf(t, accounts);
    if (why) shaped.add(t.id);
    if (t.transfer === 1) out.set(t.id, "marked");
    else if (t.transfer === null && why) out.set(t.id, why);
  }
  // An Interac e-transfer can be to or from anyone, so it pairs only with a row that is itself a transfer between
  // his accounts: a friend paying him back for dinner doesn't cancel the dinner.
  const pairable = (a: TransferTx, b: TransferTx) => {
    const eA = E_TRANSFER.test(a.description);
    const eB = E_TRANSFER.test(b.description);
    if (!eA && !eB) return true;
    return (eA || shaped.has(a.id)) && (eB || shaped.has(b.id)) && (shaped.has(a.id) || shaped.has(b.id));
  };
  // A refund, or a bill paid to a card he hasn't imported, is never one side of a transfer, and an e-transfer
  // between his accounts was already paired when its flow was stored.
  const pairs = (t: TransferTx) => t.transfer !== 0 && (t.flow == null || (MOVED_FLOWS.has(t.flow) && !(t.flow === "moved" && E_TRANSFER.test(t.description))));
  // Pairs, nearest date first; rows he marked as not a transfer never pair, and each row pairs once.
  const incoming = new Map<number, TransferTx[]>();
  for (const t of rows) {
    if (t.amount <= 0 || !pairs(t)) continue;
    const cents = Math.round(t.amount * 100);
    const list = incoming.get(cents);
    if (list) list.push(t);
    else incoming.set(cents, [t]);
  }
  const used = new Set<string>();
  for (const t of rows) {
    if (t.amount >= 0 || !pairs(t)) continue;
    const candidates = (incoming.get(Math.round(-t.amount * 100)) ?? []).filter(
      (c) =>
        !used.has(c.id) &&
        c.account !== t.account &&
        Math.abs(dayOf(c.date) - dayOf(t.date)) <= (shaped.has(t.id) || shaped.has(c.id) ? PAIR_DAYS : PLAIN_PAIR_DAYS) &&
        pairable(t, c),
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
  // An e-transfer he says isn't a transfer stops pairing, so its other side is looked at again too.
  reflowMoney(db, spaceId);
  bus.emit({ type: "changed" });
}
