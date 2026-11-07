import type { Database } from "bun:sqlite";
import { getSetting, setSetting } from "../settings";

// What a bank or card row is beyond its amount, decided from its account, its description and which of Nakul's
// accounts are imported. Stored in money_transactions.flow so the transactions list can say why, and worked out
// again on open and after every import, undo or move, since importing a card changes what paying it means.
//   card-payment  a payment arriving on one of his cards: never money in, never spending
//   card-paid     a payment from chequing to a card he has imported: money moving between his accounts
//   card-bill     a payment from chequing to a card he hasn't imported: spending, so the money isn't lost
//   moved         a bank's own transfer between his accounts (Wealthsimple's Internal transfer), an e-transfer
//                 out of one of his accounts that arrives in another, or one sent to his own name
//   refund        any other credit on a card: takes spending down, never money in
export type Flow = "card-payment" | "card-paid" | "card-bill" | "moved" | "refund";
// Flows that are money moving between his own accounts, unless he says otherwise.
export const MOVED_FLOWS = new Set<Flow | null>(["card-payment", "card-paid", "moved"]);
export const CARD_BILL = "Credit card payment";

type Row = { id: string; date: string; account: string; description: string; amount: number; kind: string; flow: Flow | null; transfer: number | null };

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

export function flowOf(t: Pick<Row, "account" | "description" | "amount" | "kind">, accounts: string[]): Flow | null {
  if (t.kind === "transfer") return "moved";
  if (isCard(t.account)) return t.amount > 0 ? (CARD_PAYMENT.test(t.description) ? "card-payment" : "refund") : null;
  if (t.amount >= 0) return null;
  const to = TO_CARD.find((p) => p.re.test(t.description));
  if (!to) return null;
  return accounts.some(to.card) ? "card-paid" : "card-bill";
}

export const E_TRANSFER = /e-?\s?transfer|e-?tfr|e-?trf|interac/i;
const PAIR_DAYS = 3;
const DAY_MS = 86_400_000;
const dayOf = (date: string) => Date.parse(`${date}T12:00:00Z`) / DAY_MS;
const words = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
export const toOwner = (description: string, owner: string | null) => !!owner && words(owner).trim() !== "" && words(description).includes(words(owner));
// The name an e-transfer was sent to, or "" when the bank hides it (TD's "SEND E-TFR ***ab2"): what's left once the
// e-transfer words and masked codes are gone.
const FILLER = new Set(["send", "sent", "to", "from", "interac", "epay", "e", "transfer", "tfr", "trf", "etransfer", "etfr", "email", "money", "auto", "deposit", "withdrawal"]);
export const payeeOf = (description: string) =>
  description
    .replace(E_TRANSFER, " ")
    .split(/\s+/)
    .filter((w) => w && !/[\d*]/.test(w) && !FILLER.has(w.toLowerCase().replace(/[^a-z]/g, "")) && /[a-z]/i.test(w))
    .join(" ");

// Every row's flow, given all of one space's rows. On top of each row's own call, e-transfers between his accounts:
// one out of an account (to his own name, or with the payee hidden) and one into a different account of his, the
// exact same amount within 3 days, nearest date first and each row used once; and any sent to his own name, paired
// or not. Rows he marked as not a transfer are
// left out of this, so his mark keeps the other side counted too.
export function flowsFor(rows: Row[], owner: () => string | null): Map<string, Flow | null> {
  const accounts = [...new Set(rows.map((r) => r.account))];
  const out = new Map(rows.map((r) => [r.id, flowOf(r, accounts)]));
  const open = (r: Row) => out.get(r.id) === null && r.transfer !== 0 && !isCard(r.account) && E_TRANSFER.test(r.description);
  const outgoing = rows.filter((r) => r.amount < 0 && open(r));
  if (!outgoing.length) return out;
  const name = owner();
  const own = new Set(outgoing.filter((r) => toOwner(r.description, name)).map((r) => r.id));
  // One that names someone else is spending, always; only those to his name or to a hidden payee may pair.
  const sent = outgoing.filter((r) => own.has(r.id) || !payeeOf(r.description));
  const arrived = rows.filter((r) => r.amount > 0 && open(r));
  const used = new Set<string>();
  // Those to his own name pick first, so a hidden payee of the same amount never takes their pair.
  for (const t of [...sent].sort((a, b) => +own.has(b.id) - +own.has(a.id))) {
    const match = arrived
      .filter((c) => !used.has(c.id) && c.account !== t.account && Math.round(c.amount * 100) === Math.round(-t.amount * 100) && Math.abs(dayOf(c.date) - dayOf(t.date)) <= PAIR_DAYS)
      .sort((a, b) => Math.abs(dayOf(a.date) - dayOf(t.date)) - Math.abs(dayOf(b.date) - dayOf(t.date)))[0];
    if (match) {
      used.add(match.id);
      out.set(match.id, "moved");
    }
    if (match || own.has(t.id)) out.set(t.id, "moved");
  }
  return out;
}

// The name his own e-transfers go to: his own setting, else the Mac user's full name.
const OWNER_KEY = "money.ownerName";
let macName: string | null | undefined;
function macUserName(): string | null {
  if (macName === undefined) {
    const r = Bun.spawnSync(["id", "-F"], { stdout: "pipe", stderr: "pipe" });
    macName = r.exitCode === 0 ? r.stdout.toString().trim() || null : null;
  }
  return macName;
}
export const ownerName = (db: Database): string | null => getSetting(db, OWNER_KEY) || macUserName();
export function setOwnerName(db: Database, name: string): void {
  setSetting(db, OWNER_KEY, name.trim());
  reflowMoney(db);
}

// Every bank row, in every space or one, decided again; only rows whose decision changed are written. Nakul's own
// mark (the transfer column) is never touched. Returns how many rows changed, so a second run returns 0.
export function reflowMoney(db: Database, spaceId?: string): number {
  const spaces = spaceId ? [spaceId] : (db.query("SELECT DISTINCT space_id AS id FROM money_transactions WHERE source = 'bank'").all() as { id: string }[]).map((s) => s.id);
  const put = db.query("UPDATE money_transactions SET flow = ? WHERE id = ?");
  const owner = () => ownerName(db);
  let changed = 0;
  db.transaction(() => {
    for (const space of spaces) {
      const rows = db.query("SELECT id, date, account, description, amount, kind, flow, transfer FROM money_transactions WHERE space_id = ? AND source = 'bank' ORDER BY date, rowid").all(space) as Row[];
      const flows = flowsFor(rows, owner);
      for (const r of rows) {
        const flow = flows.get(r.id) ?? null;
        if (flow === r.flow) continue;
        put.run(flow, r.id);
        changed++;
      }
    }
  })();
  return changed;
}
