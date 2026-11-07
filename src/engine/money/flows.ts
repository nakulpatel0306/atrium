import type { Database } from "bun:sqlite";

// What a bank or card row is beyond its amount, decided from its account, its description and which of Nakul's
// accounts are imported. Stored in money_transactions.flow so the transactions list can say why, and worked out
// again on open and after every import, undo or move, since importing a card changes what paying it means.
//   card-payment  a payment arriving on one of his cards: never money in, never spending
//   card-paid     a payment from chequing to a card he has imported: money moving between his accounts
//   card-bill     a payment from chequing to a card he hasn't imported: spending, so the money isn't lost
//   moved         a bank's own transfer between his accounts (Wealthsimple's Internal transfer)
//   refund        any other credit on a card: takes spending down, never money in
export type Flow = "card-payment" | "card-paid" | "card-bill" | "moved" | "refund";
// Flows that are money moving between his own accounts, unless he says otherwise.
export const MOVED_FLOWS = new Set<Flow | null>(["card-payment", "card-paid", "moved"]);
export const CARD_BILL = "Credit card payment";

type Row = { id: string; account: string; description: string; amount: number; kind: string; flow: Flow | null };

export const isCard = (account: string) => /credit card|\bamex\b|american express|\bvisa\b|master ?card/i.test(account);
const isAmex = (account: string) => /\bamex\b|american express/i.test(account);
const isTdCard = (account: string) => /\btd\b/i.test(account) && isCard(account);

// On a card, a credit that pays it off: "PAYMENT - THANK YOU" (TD), "PAYMENT RECEIVED - THANK YOU" (Amex).
const CARD_PAYMENT = /\bpayment\b|\bpymt\b|\bautopay\b/i;
// From chequing, a payment to a card, and which of his cards it pays.
const TO_CARD: { re: RegExp; card: (account: string) => boolean }[] = [
  { re: /\bamex\b.*\b(bill|payment|pymt|pmt)\b/i, card: isAmex },
  { re: /tfr-to c\/c|td visa (preauth|pymt|payment)/i, card: isTdCard },
];

export function flowOf(t: Omit<Row, "id" | "flow">, accounts: string[]): Flow | null {
  if (t.kind === "transfer") return "moved";
  if (isCard(t.account)) return t.amount > 0 ? (CARD_PAYMENT.test(t.description) ? "card-payment" : "refund") : null;
  if (t.amount >= 0) return null;
  const to = TO_CARD.find((p) => p.re.test(t.description));
  if (!to) return null;
  return accounts.some(to.card) ? "card-paid" : "card-bill";
}

// Every bank row, in every space or one, decided again; only rows whose decision changed are written. Nakul's own
// mark (the transfer column) is never touched. Returns how many rows changed, so a second run returns 0.
export function reflowMoney(db: Database, spaceId?: string): number {
  const spaces = spaceId ? [spaceId] : (db.query("SELECT DISTINCT space_id AS id FROM money_transactions WHERE source = 'bank'").all() as { id: string }[]).map((s) => s.id);
  const put = db.query("UPDATE money_transactions SET flow = ? WHERE id = ?");
  let changed = 0;
  db.transaction(() => {
    for (const space of spaces) {
      const rows = db.query("SELECT id, account, description, amount, kind, flow FROM money_transactions WHERE space_id = ? AND source = 'bank'").all(space) as Row[];
      const accounts = [...new Set(rows.map((r) => r.account))];
      for (const r of rows) {
        const flow = flowOf(r, accounts);
        if (flow === r.flow) continue;
        put.run(flow, r.id);
        changed++;
      }
    }
  })();
  return changed;
}
