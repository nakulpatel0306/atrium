// E-transfers Nakul sends himself: out of Wealthsimple chequing to his own name, arriving in TD chequing a day or
// so later. They move money between his accounts; e-transfers to anyone else are spending. Fake data only.
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../../src/engine/db";
import { createSpace } from "../../../src/engine/spaces";
import { importMoney, previewMoney } from "../../../src/engine/money/import";
import { moneyView } from "../../../src/engine/money/summary";
import { recap } from "../../../src/engine/money/recap";
import { ownerName, reflowMoney, setOwnerName } from "../../../src/engine/money/flows";
import { markTransfer } from "../../../src/engine/money/transfers";
import { categorize, DEFAULT_RULES } from "../../../src/engine/money/categories";
import { tempHome } from "../../helpers";

const NOW = Date.parse("2026-11-05T15:00:00Z");
const ME = "Sam Example";

let home: ReturnType<typeof tempHome>;
let db: Database;
let spaceId: string;
beforeEach(() => {
  home = tempHome();
  db = openDb();
  spaceId = createSpace(db, { name: "Investing", kind: "markets", goal: "g" }).id;
  setOwnerName(db, ME);
});
afterEach(() => {
  db.close();
  home.cleanup();
});

const td = (rows: [string, string, number][]) => rows.map(([d, desc, a]) => `${d},${desc},${a < 0 ? (-a).toFixed(2) : ""},${a > 0 ? a.toFixed(2) : ""},1000.00`).join("\n");
const ws = (rows: [string, string, string, number][]) =>
  [
    "transaction_date,transaction_time,account_number,account_type,transaction_type,transaction_sub_type,status,payee,payee_email,amount,currency",
    ...rows.map(([d, type, payee, a]) => `${d},12:00:00,WK000000000CAD,Chequing,${type},E Transfer,posted,${payee},,${a.toFixed(2)},CAD`),
  ].join("\n");
const month = () => {
  importMoney(
    db,
    spaceId,
    previewMoney(
      ws([
        ["2026-10-05", "Withdrawal", ME, -200],
        // A friend, the same amount three days later: still spending, and it doesn't take the pair above.
        ["2026-10-08", "Withdrawal", "Jordan Fakename", -200],
        // To his own name with nothing arriving: moved anyway.
        ["2026-10-12", "Withdrawal", ME, -150],
        ["2026-10-16", "Deposit", ME, 300],
        ["2026-10-20", "Withdrawal", "Casey", -75],
      ]),
    ),
  );
  importMoney(
    db,
    spaceId,
    previewMoney(
      td([
        ["10/06/2026", "E-TRANSFER ***x1Y", 200],
        ["10/14/2026", "SEND E-TFR ***ab2", -300],
        ["10/15/2026", "PAYROLL DEP NORTHWIND", 2150],
        ["10/22/2026", "E-TFR *** EPAY", 60],
      ]),
      { account: "TD chequing" },
    ),
  );
};
const rows = () => moneyView(db, spaceId, NOW, "2026-10").transactions;
const row = (date: string, account: string) => rows().find((t) => t.date === date && t.account === account)!;

test("e-transfers to himself are moved, e-transfers to others are spending, and only pay and others' e-transfers are money in", () => {
  month();
  const v = moneyView(db, spaceId, NOW, "2026-10");
  expect(v.income).toBe(2150 + 60);
  expect(v.spent).toBe(275);
  expect(v.spending).toEqual([{ category: "E-transfers", amount: 275, count: 2 }]);
  expect(row("2026-10-05", "Wealthsimple chequing")).toMatchObject({ flow: "moved", transfer: "own" });
  expect(row("2026-10-06", "TD chequing")).toMatchObject({ flow: "moved", transfer: "own" });
  expect(row("2026-10-08", "Wealthsimple chequing")).toMatchObject({ flow: null, transfer: null, category: "E-transfers" });
  expect(row("2026-10-12", "Wealthsimple chequing")).toMatchObject({ flow: "moved", transfer: "own" });
  // TD to Wealthsimple pairs the same way, whoever the payee is.
  expect(row("2026-10-14", "TD chequing")).toMatchObject({ flow: "moved" });
  expect(row("2026-10-16", "Wealthsimple chequing")).toMatchObject({ flow: "moved" });
  expect(row("2026-10-22", "TD chequing")).toMatchObject({ flow: null, transfer: null });
  const r = recap(db, spaceId, NOW, "2026-10")!;
  expect(r.income).toBe(2210);
  // Each pair once: 200 and 300 paired, 150 to himself unpaired.
  expect(r.moved).toEqual({ count: 5, total: 650 });
  expect(r.eTransfers).toEqual({ count: 2, total: 275 });
});

test("pairs need different accounts, the exact amount and at most 3 days", () => {
  importMoney(db, spaceId, previewMoney(ws([["2026-10-05", "Withdrawal", "Casey", -40], ["2026-10-05", "Withdrawal", "Jordan Fakename", -55]])));
  importMoney(db, spaceId, previewMoney(td([["10/09/2026", "E-TRANSFER ***a1B", 40], ["10/06/2026", "E-TRANSFER ***c2D", 55.01], ["10/02/2026", "SEND E-TFR ***ab2", -25], ["10/03/2026", "E-TRANSFER ***e3F", 25]]), { account: "TD chequing" }));
  expect(rows().filter((t) => t.flow === "moved")).toEqual([]);
  expect(moneyView(db, spaceId, NOW, "2026-10").income).toBe(120.01);
});

test("an e-transfer naming someone else never pairs; a hidden payee or his own name may", () => {
  importMoney(db, spaceId, previewMoney(ws([["2026-10-05", "Withdrawal", "Casey", -40], ["2026-10-07", "Withdrawal", "", -90]])));
  importMoney(db, spaceId, previewMoney(td([["10/05/2026", "E-TRANSFER ***a1B", 40], ["10/08/2026", "E-TFR *** EPAY", 90], ["10/09/2026", "SEND E-TFR ***ab2", -25], ["10/10/2026", "E-transfer ***k9", 25]]), { account: "TD chequing" }));
  expect(row("2026-10-05", "Wealthsimple chequing")).toMatchObject({ flow: null, category: "E-transfers" });
  expect(row("2026-10-05", "TD chequing").flow).toBeNull();
  expect(row("2026-10-07", "Wealthsimple chequing").flow).toBe("moved");
  expect(row("2026-10-08", "TD chequing").flow).toBe("moved");
  // TD to TD is the same account, so the hidden one there stays spending.
  expect(row("2026-10-09", "TD chequing").flow).toBeNull();
});

test("only outgoing rows count for his own name", () => {
  importMoney(db, spaceId, previewMoney(ws([["2026-10-16", "Deposit", ME, 300]])));
  expect(row("2026-10-16", "Wealthsimple chequing")).toMatchObject({ flow: null, transfer: null });
  expect(moneyView(db, spaceId, NOW, "2026-10").income).toBe(300);
});

test("re-evaluation stays idempotent with pairs, runs on open, and follows his marks and his name", () => {
  month();
  const flows = () => db.query("SELECT id, flow FROM money_transactions ORDER BY id").all();
  const first = flows();
  expect(reflowMoney(db)).toBe(0);
  db.query("UPDATE money_transactions SET flow = NULL").run();
  db.close();
  db = openDb();
  expect(flows()).toEqual(first);
  // He says the 200 to himself wasn't a transfer: the TD side is money in again, and the friend's same-amount
  // e-transfer two days later never takes its place.
  const mine = row("2026-10-05", "Wealthsimple chequing").id;
  markTransfer(db, spaceId, mine, false);
  expect(row("2026-10-06", "TD chequing")).toMatchObject({ flow: null, transfer: null });
  expect(row("2026-10-08", "Wealthsimple chequing")).toMatchObject({ flow: null, transfer: null, category: "E-transfers" });
  markTransfer(db, spaceId, mine, null);
  expect(flows()).toEqual(first);
  // He says the 300 from TD wasn't a transfer: both sides count again.
  const sent = row("2026-10-14", "TD chequing").id;
  markTransfer(db, spaceId, sent, false);
  expect(row("2026-10-16", "Wealthsimple chequing")).toMatchObject({ flow: null, transfer: null });
  expect(moneyView(db, spaceId, NOW, "2026-10").income).toBe(2510);
  markTransfer(db, spaceId, sent, null);
  expect(flows()).toEqual(first);
  // Another name: the unpaired one becomes spending.
  setOwnerName(db, "Someone Else");
  expect(row("2026-10-12", "Wealthsimple chequing")).toMatchObject({ flow: null, category: "E-transfers" });
});

test("his name defaults to the Mac user's full name", () => {
  db.query("DELETE FROM settings WHERE key = 'money.ownerName'").run();
  const mac = Bun.spawnSync(["id", "-F"]).stdout.toString().trim();
  expect(ownerName(db)).toBe(mac || null);
});

test("TD's SEND E-TFR is in the Transfers category, and one sent to a friend is still spending", () => {
  expect(categorize("SEND E-TFR ***ab2", DEFAULT_RULES)).toBe("Transfers");
  importMoney(db, spaceId, previewMoney(td([["10/14/2026", "SEND E-TFR ***ab2", -45], ["10/15/2026", "LOBLAWS #1234", -20]]), { account: "TD chequing" }));
  const v = moneyView(db, spaceId, NOW, "2026-10");
  expect(v.spent).toBe(65);
  expect(v.spending.find((s) => s.category === "E-transfers")!.amount).toBe(45);
});
