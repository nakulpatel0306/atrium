// Card payments, refunds and money in, from Nakul's first real month: paying a card is money moving between his own
// accounts, a credit on a card is a refund, and only pay, e-transfers received and interest are money in. Fixtures
// are shaped like his four accounts after masking, with fake data only.
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../../src/engine/db";
import { createSpace } from "../../../src/engine/spaces";
import { importMoney, isMasked, previewMoney } from "../../../src/engine/money/import";
import { moneyFacts, moneyView } from "../../../src/engine/money/summary";
import { recap, recapFacts } from "../../../src/engine/money/recap";
import { reflowMoney } from "../../../src/engine/money/flows";
import { markTransfer } from "../../../src/engine/money/transfers";
import { checkBudgets, setBudget } from "../../../src/engine/money/budgets";
import { listRules } from "../../../src/engine/money/categories";
import { subscriptions } from "../../../src/engine/money/subscriptions";
import { counted, txs } from "../../../src/engine/money/rows";
import { tempHome } from "../../helpers";

const NOW = Date.parse("2026-11-05T15:00:00Z");

let home: ReturnType<typeof tempHome>;
let db: Database;
let spaceId: string;
beforeEach(() => {
  home = tempHome();
  db = openDb();
  spaceId = createSpace(db, { name: "Investing", kind: "markets", goal: "g" }).id;
});
afterEach(() => {
  db.close();
  home.cleanup();
});

// TD's headerless layout: date, description, money out, money in, balance.
const td = (rows: [string, string, number][]) => rows.map(([d, desc, a]) => `${d},${desc},${a < 0 ? (-a).toFixed(2) : ""},${a > 0 ? a.toFixed(2) : ""},1000.00`).join("\n");
const chequing = () =>
  importMoney(
    db,
    spaceId,
    previewMoney(
      td([
        ["10/02/2026", "LOBLAWS #1234", -80],
        ["10/10/2026", "WT505 TFR-TO C/C", -120],
        ["10/15/2026", "PAYROLL DEP NORTHWIND", 2150],
        ["10/18/2026", "E-TRANSFER ***K7q", 60],
        ["10/20/2026", "WT506 TFR-TO C/C", -45],
        ["10/22/2026", "AMEX BILL PYMT   MSP", -800],
        ["10/30/2026", "PAYROLL DEP NORTHWIND", 2150],
      ]),
      { account: "TD chequing" },
    ),
  );
const tdCard = () =>
  importMoney(
    db,
    spaceId,
    previewMoney(
      td([
        ["10/04/2026", "UBER* TRIP", -25],
        ["10/10/2026", "PAYMENT - THANK YOU", 120],
        ["10/12/2026", "LOBLAWS #1234", -50],
        ["10/20/2026", "PAYMENT - THANK YOU", 45],
      ]),
      { account: "TD credit card" },
    ),
  );
// Amex lists charges as positive.
const amex = () =>
  importMoney(
    db,
    spaceId,
    previewMoney("Date,Description,Amount\n2026-10-06,NETFLIX.COM,16.49\n2026-10-09,BEST BUY #921,300.00\n2026-10-19,BEST BUY #921,-100.00\n2026-10-23,PAYMENT RECEIVED - THANK YOU,-800.00", {
      account: "Amex",
      signs: "positive-out",
    }),
  );
const wsChequing = () =>
  importMoney(
    db,
    spaceId,
    previewMoney(
      [
        "transaction_date,transaction_time,account_number,account_type,transaction_type,transaction_sub_type,status,payee,payee_email,amount,currency",
        "2026-10-11,12:00:00,WK000000000CAD,Chequing,Internal Transfer,Source,posted,,,-500.00,CAD",
        "2026-10-31,23:59:59,WK000000000CAD,Chequing,Interest,,posted,,,3.21,CAD",
      ].join("\n"),
    ),
  );
const all = () => {
  chequing();
  tdCard();
  amex();
  wsChequing();
};
const tx = (description: string, account?: string) =>
  moneyView(db, spaceId, NOW, "2026-10").transactions.find((t) => t.description === description && (!account || t.account === account))!;
const AMEX = "AMEX BILL PYMT   MSP";
const idOf = (description: string, account: string) => (db.query("SELECT id FROM money_transactions WHERE description = ? AND account = ?").get(description, account) as { id: string }).id;

test("with both cards paid from TD chequing, money in is only pay, e-transfers received and interest", () => {
  all();
  const v = moneyView(db, spaceId, NOW, "2026-10");
  expect(v.income).toBe(2150 + 2150 + 60 + 3.21);
  const r = recap(db, spaceId, NOW, "2026-10")!;
  expect(r.income).toBe(4363.21);
});

test("spending leaves the card payments out, and a refund on a card takes its category down", () => {
  all();
  const v = moneyView(db, spaceId, NOW, "2026-10");
  // Loblaws twice, Uber, Netflix, and Best Buy less its refund.
  expect(v.spent).toBe(371.49);
  expect(v.spending.find((s) => s.category === "Shopping")!.amount).toBe(200);
  expect(v.spending.map((s) => s.category)).not.toContain("Credit card payment");
  const r = recap(db, spaceId, NOW, "2026-10")!;
  expect(r.spent).toBe(371.49);
  expect(r.refunds).toEqual({ count: 1, total: 100 });
  // The chequing side of each payment, and the Wealthsimple internal transfer.
  expect(r.moved).toEqual({ count: 7, total: 1465 });
  expect(r.net).toBe(3991.72);
});

test("each card payment says why it was left out", () => {
  all();
  expect(tx("PAYMENT - THANK YOU")).toMatchObject({ transfer: "card-payment", flow: "card-payment" });
  expect(tx("PAYMENT RECEIVED - THANK YOU")).toMatchObject({ transfer: "card-payment" });
  expect(tx("WT505 TFR-TO C/C")).toMatchObject({ transfer: "card-paid", flow: "card-paid" });
  expect(tx(AMEX)).toMatchObject({ transfer: "card-paid" });
  expect(moneyView(db, spaceId, NOW, "2026-10").transactions.find((t) => t.account === "Amex" && t.amount === 100)).toMatchObject({ transfer: null, flow: "refund", category: "Shopping" });
});

test("an Amex bill paid from chequing with no Amex imported counts as spending", () => {
  chequing();
  tdCard();
  const v = moneyView(db, spaceId, NOW, "2026-10");
  expect(v.spending.find((s) => s.category === "Credit card payment")).toEqual({ category: "Credit card payment", amount: 800, count: 1 });
  expect(tx(AMEX)).toMatchObject({ transfer: null, flow: "card-bill", category: "Credit card payment" });
  // The TD card is here, so its payments still move between accounts.
  expect(tx("WT505 TFR-TO C/C")).toMatchObject({ transfer: "card-paid" });
});

test("TFR-TO C/C with no TD card imported counts as spending", () => {
  chequing();
  amex();
  expect(tx("WT505 TFR-TO C/C")).toMatchObject({ transfer: null, flow: "card-bill", category: "Credit card payment" });
  expect(tx(AMEX)).toMatchObject({ transfer: "card-paid" });
});

test("the Wealthsimple internal transfer moves between accounts", () => {
  wsChequing();
  const v = moneyView(db, spaceId, NOW, "2026-10");
  expect(tx("Internal transfer")).toMatchObject({ transfer: "known", flow: "moved" });
  expect(v.spent).toBe(0);
  expect(v.income).toBe(3.21);
});

test("e-transfers received are money in", () => {
  importMoney(db, spaceId, previewMoney(td([["10/03/2026", "LOBLAWS #1234", -40], ["10/18/2026", "E-TRANSFER ***K7q", 60], ["10/19/2026", "INTERAC E-TRF FROM SAM", 25]]), { account: "TD chequing" }));
  const v = moneyView(db, spaceId, NOW, "2026-10");
  expect(v.income).toBe(85);
  expect(v.spent).toBe(40);
});

test("his own mark still wins: a card payment he says isn't a transfer is a refund, never money in", () => {
  all();
  const id = idOf("PAYMENT - THANK YOU", "TD credit card");
  const before = moneyView(db, spaceId, NOW, "2026-10");
  markTransfer(db, spaceId, id, false);
  const after = moneyView(db, spaceId, NOW, "2026-10");
  expect(after.income).toBe(before.income);
  // A refund only takes down a category charged this month; nothing on the cards is in Other, so spending holds.
  expect(after.spent).toBe(before.spent);
  expect(after.transactions.find((t) => t.id === id)).toMatchObject({ transfer: null, mark: 0, flow: "card-payment" });
  markTransfer(db, spaceId, id, null);
  expect(moneyView(db, spaceId, NOW, "2026-10").spent).toBe(before.spent);
  // And a chequing payment he marks as not a transfer is spending.
  markTransfer(db, spaceId, idOf(AMEX, "TD chequing"), false);
  expect(moneyView(db, spaceId, NOW, "2026-10").spent).toBe(before.spent + 800);
});

test("re-evaluating stored rows is idempotent, runs on open, and follows the accounts imported", () => {
  all();
  const flows = () => db.query("SELECT id, flow FROM money_transactions ORDER BY id").all();
  const first = flows();
  expect(reflowMoney(db)).toBe(0);
  expect(flows()).toEqual(first);
  // Rows from before this change have no decision stored; opening the database makes it.
  db.query("UPDATE money_transactions SET flow = NULL").run();
  db.close();
  db = openDb();
  expect(flows()).toEqual(first);
  expect(reflowMoney(db)).toBe(0);
  // His marks are never touched by it.
  const id = idOf("PAYMENT - THANK YOU", "TD credit card");
  markTransfer(db, spaceId, id, false);
  reflowMoney(db);
  expect((db.query("SELECT transfer FROM money_transactions WHERE id = ?").get(id) as { transfer: number }).transfer).toBe(0);
});

test("importing the card later turns its earlier bill payments into transfers", () => {
  chequing();
  expect(tx(AMEX).flow).toBe("card-bill");
  amex();
  expect(tx(AMEX)).toMatchObject({ flow: "card-paid", transfer: "card-paid" });
});

test("budgets ignore transfers and count refunds", () => {
  all();
  setBudget(db, spaceId, "Other", 100);
  setBudget(db, spaceId, "Shopping", 1000);
  const v = moneyView(db, spaceId, NOW, "2026-10");
  // Nothing in Other: the card payments and the internal transfer aren't spending.
  expect(v.budgets.find((b) => b.category === "Other")!.spent).toBe(0);
  expect(v.budgets.find((b) => b.category === "Shopping")!.spent).toBe(200);
  expect(checkBudgets(db, spaceId, NOW)).toBe(0);
});

test("subscriptions ignore card payments, whether they're transfers or an unimported card's bill", () => {
  const months = ["08", "09", "10"];
  importMoney(db, spaceId, previewMoney(td(months.flatMap((m) => [[`${m}/10/2026`, "WT505 TFR-TO C/C", -120], [`${m}/22/2026`, "AMEX BILL PYMT   MSP", -300]] as [string, string, number][])), { account: "TD chequing" }));
  importMoney(db, spaceId, previewMoney(td(months.map((m) => [`${m}/10/2026`, "PAYMENT - THANK YOU", 120] as [string, string, number])), { account: "TD credit card" }));
  const s = subscriptions(counted(txs(db, spaceId, "bank")), listRules(db, spaceId));
  expect([...s.list, ...s.bills.list]).toEqual([]);
});

test("the recap and Explain my month name spent, money in, refunds and money moved separately", () => {
  all();
  const r = recap(db, spaceId, NOW, "2026-10")!;
  const facts = recapFacts(r);
  expect(facts).toContain("Spent CA$371.49; money in CA$4,363.21; left over CA$3,991.72.");
  expect(facts).toContain("Money in is pay, e-transfers received and interest.");
  expect(facts).toContain("Refunds of CA$100.00 on 1 charge were taken off spending.");
  expect(facts).toContain("Moved between Nakul's own accounts (card payments and transfers): CA$1,465.00, not counted as spending or money in.");
  for (const f of facts) expect(isMasked(f)).toBe(true);
  const month = moneyFacts(db, spaceId, NOW).find((l) => l.startsWith("- October 2026"))!;
  expect(month).toContain("money in CA$4,363.21");
  expect(month).toContain("refunds CA$100.00");
  expect(month).toContain("moved between his accounts CA$1,465.00");
});
