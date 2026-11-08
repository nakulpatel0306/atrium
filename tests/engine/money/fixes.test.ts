// Fixes from Nakul's first real imports: TD's second layout, Wealthsimple chequing and savings statements,
// duplicates across layouts, and undoing or relabelling an import. Fixtures mirror the layouts with fake data only.
import { addAccount } from "../../../src/engine/money/accounts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../../../src/engine/db";
import { createSpace } from "../../../src/engine/spaces";
import { createTask } from "../../../src/engine/tasks";
import { importMoney, normalDescription, previewMoney } from "../../../src/engine/money/import";
import { changeImportAccount, listImports, undoImport } from "../../../src/engine/money/imports";
import { monthCover } from "../../../src/engine/money/coverage";
import { tempHome } from "../../helpers";

const DIR = join(import.meta.dir, "../../fixtures/money");
const csv = (name: string) => readFileSync(join(DIR, name), "utf8");

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

const count = (account?: string) =>
  (db.query(`SELECT COUNT(*) AS n FROM money_transactions${account ? " WHERE account = ?" : ""}`).get(...(account ? [account] : [])) as { n: number }).n;

// ---- Detection ----

test("TD's quoted ISO layout is detected as TD chequing", () => {
  const p = previewMoney(csv("td-chequing-iso.csv"));
  expect(p.bank).toMatchObject({ id: "td", account: "TD chequing" });
  expect(p.account).toBe("TD chequing");
  expect(p.rows).toHaveLength(11);
  expect(p.rows[0]).toMatchObject({ date: "2026-10-01", amount: -1650, account: "TD chequing" });
  expect(p.rows[3]).toMatchObject({ date: "2026-10-15", amount: 2150, kind: "income" });
  expect(p.rows.find((r) => r.description.startsWith("SEND E-TFR"))).toMatchObject({ amount: -12.34 });
});

test("TD's quoted ISO card file is told apart by its card lines", () => {
  const card = ['"2026-10-05","INTEREST CHARGE","3.21",,"812.00"', '"2026-10-08","PAYMENT - THANK YOU",,"400.00","412.00"', '"2026-10-09","LOBLAWS #1234","20.00",,"432.00"'].join("\n");
  expect(previewMoney(card).bank).toMatchObject({ id: "td", account: "TD credit card" });
  // A chequing file pays the card from its side; that doesn't make it a card.
  const chq = ['"2026-10-05","TFR-TO C/C","400.00",,"812.00"', '"2026-10-08","SEND E-TFR ***ab2","20.00",,"792.00"'].join("\n");
  expect(previewMoney(chq).bank).toMatchObject({ id: "td", account: "TD chequing" });
  // The older headerless layout still reads the same way.
  expect(previewMoney(csv("td-chequing.csv")).bank).toMatchObject({ id: "td", account: "TD chequing" });
  expect(previewMoney(csv("td-credit.csv")).bank).toMatchObject({ id: "td", account: "TD credit card" });
});

test("a Wealthsimple chequing export: payee or type as the description, only posted rows, transfers and pay", () => {
  const p = previewMoney(csv("ws-chequing.csv"));
  expect(p.bank).toMatchObject({ id: "ws-chequing", label: "Wealthsimple chequing", account: "Wealthsimple chequing" });
  expect(p.format).toBe("bank");
  expect(p.account).toBe("Wealthsimple chequing");
  expect(p.rows.map((r) => [r.date, r.description, r.amount, r.kind])).toEqual([
    ["2026-10-01", "NORTHWIND PAYROLL", 2150, "income"],
    ["2026-10-03", "E-transfer Jane Fakename", -40, "spend"],
    ["2026-10-10", "Internal transfer", -500, "transfer"],
    ["2026-10-31", "Interest", 3.12, "interest"],
  ]);
  expect(p.rows.every((r) => r.source === "bank" && r.account === "Wealthsimple chequing")).toBe(true);
  expect(p.skipped).toEqual([{ line: 6, reason: "Not posted yet." }]);
  // The account number and payee email columns never reach a row, the headers aside.
  const text = JSON.stringify(p.rows);
  for (const s of ["WK000000000CAD", "WKFAKEACCTCAD", "example.com", "fakename@"]) expect(text.includes(s)).toBe(false);
});

test("a Wealthsimple chequing amount written without a sign follows its type", () => {
  const head = "transaction_date,transaction_time,account_number,account_type,transaction_type,transaction_sub_type,status,payee,payee_email,amount,currency";
  const p = previewMoney([head, "2026-10-03,18:01:02,WK000000000CAD,Chequing,Withdrawal,E Transfer,COMPLETED,Jane Fakename,,40.00,CAD", "2026-10-04,08:00:00,WK000000000CAD,Chequing,Internal Transfer,Destination,posted,,,25.00,CAD"].join("\n"));
  expect(p.rows.map((r) => [r.amount, r.kind])).toEqual([
    [-40, "spend"],
    [25, "transfer"],
  ]);
});

test("a Wealthsimple savings monthly statement with its currency column is detected", () => {
  const p = previewMoney(csv("ws-savings-statement.csv"));
  expect(p.bank).toMatchObject({ id: "ws-cash", label: "Wealthsimple savings", account: "Wealthsimple savings" });
  expect(p.rows.map((r) => [r.date, r.amount, r.kind])).toEqual([
    ["2026-10-02", 300, "income"],
    ["2026-10-09", -20, "spend"],
    ["2026-10-17", -100, "transfer"],
    ["2026-10-31", 11.02, "interest"],
  ]);
  expect(p.rows.every((r) => r.account === "Wealthsimple savings")).toBe(true);
});

test("a savings statement covers its whole month, quiet first week and all", () => {
  const late = ['"date","transaction","description","amount","balance","currency"', '"2026-09-17","AFT_IN","Top up","100.00","100.00","CAD"', '"2026-09-30","INT","Interest","0.20","100.20","CAD"'].join("\n");
  importMoney(db, spaceId, previewMoney(late));
  const cover = monthCover(db, spaceId, "2026-09", "2026-11-05");
  expect(cover.accounts).toEqual([{ account: "Wealthsimple savings", complete: true, through: "2026-09-30" }]);
  expect(cover.complete).toBe(true);
  expect(db.query("SELECT period_start, period_end FROM money_imports").get()).toEqual({ period_start: "2026-09-01", period_end: "2026-09-30" });
});

// ---- Duplicates across layouts ----

test("normalised descriptions ignore case, spacing, quotes and trailing codes", () => {
  expect(normalDescription(' "Summit Fitness   fitness" ')).toBe("SUMMIT FITNESS FITNESS");
  expect(normalDescription("SEND E-TFR ***zb1")).toBe("SEND E-TFR");
  expect(normalDescription("ROGERS ******1234")).toBe("ROGERS");
  expect(normalDescription("ROGERS ··1234")).toBe("ROGERS");
  expect(normalDescription("WEALTHSIMPLE ")).toBe("WEALTHSIMPLE");
  // A description that is only a code keeps it, so it still means something.
  expect(normalDescription("··1234")).toBe("··1234");
});

test("TD chequing arriving in both layouts is stored once, in either order", () => {
  importMoney(db, spaceId, previewMoney(csv("td-chequing.csv")));
  const before = count("TD chequing");
  expect(importMoney(db, spaceId, previewMoney(csv("td-chequing-iso.csv")))).toEqual({ added: 2, duplicates: 9 });
  expect(count("TD chequing")).toBe(before + 2);

  db.query("DELETE FROM money_transactions").run();
  db.query("DELETE FROM money_imports").run();
  importMoney(db, spaceId, previewMoney(csv("td-chequing-iso.csv")));
  expect(importMoney(db, spaceId, previewMoney(csv("td-chequing.csv")))).toEqual({ added: 19, duplicates: 9 });
  expect(count()).toBe(30);
});

test("identical charges in one file are all kept, and only a second import of them is a duplicate", () => {
  expect(importMoney(db, spaceId, previewMoney(csv("amex-repeats.csv")))).toEqual({ added: 4, duplicates: 0 });
  expect((db.query("SELECT COUNT(*) AS n FROM money_transactions WHERE description = 'AMERICAN AIRLINES'").get() as { n: number }).n).toBe(3);
  // The same file again in a slightly different layout adds nothing.
  const again = "Date,Description,Amount\n14 Oct 2026,American  Airlines,89.00\n14 Oct 2026,AMERICAN AIRLINES ,89.00\n14 Oct 2026,AMERICAN AIRLINES,89.00\n";
  expect(importMoney(db, spaceId, previewMoney(again, { account: "Amex", signs: "positive-out" }))).toEqual({ added: 0, duplicates: 3 });
  // A fourth one on a later statement is new.
  const more = "Date,Description,Amount\n14 Oct 2026,AMERICAN AIRLINES,89.00\n14 Oct 2026,AMERICAN AIRLINES,89.00\n14 Oct 2026,AMERICAN AIRLINES,89.00\n14 Oct 2026,AMERICAN AIRLINES,89.00\n";
  expect(importMoney(db, spaceId, previewMoney(more, { account: "Amex", signs: "positive-out" }))).toEqual({ added: 1, duplicates: 3 });
});

// ---- Undo and change account ----

test("every row knows its import, and undo removes exactly what that import added", () => {
  importMoney(db, spaceId, previewMoney(csv("td-chequing.csv")));
  importMoney(db, spaceId, previewMoney(csv("td-chequing-iso.csv")));
  const list = listImports(db, spaceId);
  expect(list.map((i) => [i.account, i.from, i.to, i.rows])).toEqual([
    ["TD chequing", "2026-10-01", "2026-11-03", 2],
    ["TD chequing", "2026-08-01", "2026-10-30", 28],
  ]);
  expect((db.query("SELECT COUNT(*) AS n FROM money_transactions WHERE import_id IS NULL").get() as { n: number }).n).toBe(0);
  expect(undoImport(db, list[0]!.id)).toEqual({ removed: 2 });
  expect(count()).toBe(28);
  expect(listImports(db, spaceId).map((i) => i.rows)).toEqual([28]);
  expect(() => undoImport(db, list[0]!.id)).toThrow("That import isn't here anymore. Refresh the page.");
});

test("undo and change account wait while Claude is looking at your money", () => {
  importMoney(db, spaceId, previewMoney(csv("amex-repeats.csv")));
  const [imp] = listImports(db, spaceId);
  createTask(db, { spaceId, title: "Money question", detail: "Where did it go?", agent: "claude", purpose: "money" });
  expect(() => undoImport(db, imp!.id)).toThrow("Claude is looking at your money. Try again when it's done.");
  expect(() => changeImportAccount(db, imp!.id, "TD credit card")).toThrow("Claude is looking at your money. Try again when it's done.");
  expect(count()).toBe(4);
});

test("change account relabels an import's rows and drops the ones that are now duplicates", () => {
  importMoney(db, spaceId, previewMoney(csv("td-chequing.csv")));
  // How the quoted file came in before: as the unknown account, doubling October.
  importMoney(db, spaceId, previewMoney(csv("td-chequing-iso.csv"), { account: "Imported" }));
  expect(count()).toBe(39);
  const unknown = listImports(db, spaceId).find((i) => i.account === "Imported")!;
  expect(changeImportAccount(db, unknown.id, "TD chequing")).toEqual({ moved: 2, dropped: 9 });
  expect(count()).toBe(30);
  expect(count("Imported")).toBe(0);
  expect(listImports(db, spaceId).map((i) => [i.account, i.rows])).toEqual([
    ["TD chequing", 2],
    ["TD chequing", 28],
  ]);
  // Fingerprints were rebuilt for the new account, so importing the file again adds nothing.
  expect(importMoney(db, spaceId, previewMoney(csv("td-chequing-iso.csv")))).toEqual({ added: 0, duplicates: 11 });
  expect(() => changeImportAccount(db, unknown.id, "My secret account")).toThrow("Pick one of your accounts.");
});

test("change account keeps one file's identical charges", () => {
  importMoney(db, spaceId, previewMoney(csv("amex-repeats.csv"), { account: "Imported" }));
  const [imp] = listImports(db, spaceId);
  addAccount(db, spaceId, { name: "Amex", kind: "credit card", institution: "Amex" });
  expect(changeImportAccount(db, imp!.id, "Amex")).toEqual({ moved: 4, dropped: 0 });
  expect(count("Amex")).toBe(4);
});

test("rows from before import ids are matched to their import when the database opens", () => {
  importMoney(db, spaceId, previewMoney(csv("amex-repeats.csv")));
  importMoney(db, spaceId, previewMoney(csv("td-chequing.csv")));
  db.query("UPDATE money_transactions SET import_id = NULL").run();
  db.close();
  db = openDb();
  const ids = db.query("SELECT t.account, i.account AS logged FROM money_transactions t JOIN money_imports i ON i.id = t.import_id").all() as { account: string; logged: string }[];
  expect(ids).toHaveLength(32);
  expect(ids.every((r) => r.account === r.logged)).toBe(true);
});

// ---- Never stored ----

test("account numbers, payee emails and the statement's account id never reach the database file", () => {
  importMoney(db, spaceId, previewMoney(csv("ws-chequing.csv")));
  importMoney(db, spaceId, previewMoney(csv("ws-savings-statement.csv")));
  const raw = readdirSync(home.home)
    .filter((f) => f.includes(".db"))
    .map((f) => readFileSync(join(home.home, f)).toString("latin1"))
    .join("\n");
  expect(raw.length).toBeGreaterThan(0);
  for (const s of ["WK000000000CAD", "WKFAKEACCTCAD", "jane.fakename@example.com", "sam.fakeperson", "example.com", "Sam Fakeperson"]) expect(raw.includes(s)).toBe(false);
  expect(raw.includes("NORTHWIND PAYROLL")).toBe(true);
});
