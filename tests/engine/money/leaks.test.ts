// Plan 14 review repros (F1–F7 in .superpowers/plan-14-review.md). Each failed on cf42d4d; all pass now.
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const W = join(import.meta.dir, "../../..");
const { openDb } = await import(`${W}/src/engine/db`);
const { createSpace } = await import(`${W}/src/engine/spaces`);
const { importMoney, isMasked, maskNumbers, previewMoney } = await import(`${W}/src/engine/money/import`);
const { moneyFacts, moneyView, requestMoneyAsk } = await import(`${W}/src/engine/money/summary`);
const { importReminder } = await import(`${W}/src/engine/money/reminder`);
const { activeNudges } = await import(`${W}/src/engine/money/nudges`);
const { recap } = await import(`${W}/src/engine/money/recap`);
const { tempHome } = await import(`${W}/tests/helpers`);

const NOW = Date.parse("2026-11-05T15:00:00Z");
let home: { home: string; cleanup(): void };
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

const digitsLeft = (s: string) => s.normalize("NFKC").replace(/[^0-9]/g, "");

// ---------- F1: card number in an amount column bypasses masker AND prompt guard ----------
test("F1 a card-number column mapped as the amount is stored raw and passes the prompt guard", () => {
  const file = ["Date,Description,Card Number,Amount", "2026-10-02,LOBLAWS,4111111111111111,-20.00"].join("\n");
  // One wrong pick in the "Columns look wrong?" mapping: Amount -> Card Number.
  const p = previewMoney(file, { mapping: { date: 0, description: 1, amount: 2 }, signs: "negative-out" });
  importMoney(db, spaceId, p);
  const amounts = (db.query("SELECT amount FROM money_transactions").all() as { amount: number }[]).map((r) => r.amount);
  const facts = moneyFacts(db, spaceId, NOW).join("\n");
  // Stored as REAL 4111111111111111 exactly; the facts say "money in CA$4,111,111,111,111,111.00" and the guard calls it masked.
  const leaked = amounts.some((a) => String(Math.abs(Math.round(a))).startsWith("41111111111"));
  expect({ leaked, factsHaveCard: digitsLeft(facts).includes("41111111111"), guardPasses: isMasked(facts) }).toEqual({ leaked: false, factsHaveCard: false, guardPasses: true });
});

test("F1b the allow-list accepts any length of comma-grouped money amount", () => {
  expect(isMasked("Spent CA$4,111,111,111,111,111.00")).toBe(false);
});

// ---------- F2: masker gaps ----------
test("F2a letters between digit groups split the cluster and every group survives", () => {
  const out = maskNumbers("REF 4111a1111b1111c1111");
  expect(digitsLeft(out)).not.toContain("41111111");
  expect(out).not.toBe("REF 4111a1111b1111c1111");
});

test("F2b Arabic-Indic and other non-ASCII decimal digits pass untouched (NFKC doesn't fold them)", () => {
  const card = "٤١١١ ١١١١ ١١١١ ١١١١"; // U+0660 block
  const deva = "४१११ ११११ ११११ ११११"; // Devanagari
  expect(isMasked(`PAYMENT ${card}`)).toBe(false);
  expect(isMasked(`PAYMENT ${deva}`)).toBe(false);
});

test("F2c a 5-character punctuation gap splits a number into safe 4-digit groups", () => {
  const out = maskNumbers("CARD 4111-----1111-----1111-----1111");
  expect(digitsLeft(out)).not.toContain("1111111111");
});

// ---------- F3: Wealthsimple Cash monthly statements never count as complete ----------
test("F3 importing each Wealthsimple Cash monthly statement never clears the reminder", () => {
  const td = readFileSync(join(W, "tests/fixtures/money/td-chequing.csv"), "utf8");
  importMoney(db, spaceId, previewMoney(td));
  const head = '"date","transaction","description","amount","balance"';
  for (const m of ["08", "09", "10"]) {
    // One statement per month, as Wealthsimple issues them: a top-up mid-month and month-end interest.
    importMoney(db, spaceId, previewMoney([head, `"2026-${m}-17","AFT_IN","Transfer in from TD","500.00","1"`, `"2026-${m}-30","INT","Interest","9.61","2"`].join("\n")));
  }
  importReminder(db, spaceId, NOW);
  const nudge = activeNudges(db, NOW).find((n: { kind: string }) => n.kind === "import");
  expect(nudge?.body ?? null).toBeNull();
  expect(moneyView(db, spaceId, NOW).coverLine).toBeNull();
});

// ---------- F4: WS Cash AFT codes treated as own-account transfers ----------
test("F4 a pre-authorised bill debit and a payroll deposit on Wealthsimple Cash vanish from the recap", () => {
  const head = '"date","transaction","description","amount","balance"';
  importMoney(db, spaceId, previewMoney([head, `"2026-10-01","AFT_IN","Direct deposit NORTHWIND PAYROLL","2150.00","2150"`, `"2026-10-05","AFT_OUT","Pre-authorized debit ROGERS","-85.00","2065"`, `"2026-10-30","SPEND","LOBLAWS","-40.00","2025"`].join("\n")));
  const r = recap(db, spaceId, NOW, "2026-10")!;
  expect({ spent: r.spent, income: r.income }).toEqual({ spent: 125, income: 2150 });
});

// ---------- F5: an exact repayment from a friend makes a real purchase vanish ----------
test("F5 a dinner on Amex repaid by e-transfer into TD the next day disappears from spending", () => {
  importMoney(db, spaceId, previewMoney("Date,Description,Amount\n2026-10-10,PAI NORTHERN THAI,60.00\n2026-10-20,LOBLAWS,40.00", { account: "Amex", signs: "positive-out" }));
  importMoney(db, spaceId, previewMoney("10/11/2026,SEND E-TFR FROM ALEX,,60.00,100.00\n10/12/2026,COFFEE,4.00,,96.00", { account: "TD chequing" }));
  const r = recap(db, spaceId, NOW, "2026-10")!;
  expect(r.spent).toBe(104);
});

// ---------- F6: the money ask gives Claude file tools and stores its output unmasked ----------
test("F6 money tasks run with Read/Glob/Grep and Claude's answer is saved without masking", async () => {
  const src = readFileSync(join(W, "src/engine/runner.ts"), "utf8");
  // allowedTools for any task with a purpose (money included) is REVIEW_TOOLS = Read, Glob, Grep.
  const toolsLine = src.split("\n").find((l) => l.includes("allowedTools:"))!;
  // Money may share its empty tool list with other tool-less kinds (Inbox tasks), but must lead to [] itself.
  const moneyGetsNoTools = /purpose\s*===\s*"money"(\s*\|\|\s*[\w.]+\s*===\s*"\w+")*\s*\?\s*\[\]/.test(toolsLine);
  const agent = readFileSync(join(W, "src/engine/markets/agent.ts"), "utf8");
  const writeupMasked = /saveWriteup\([\s\S]{0,400}maskNumbers/.test(agent) || /maskNumbers\(summary/.test(agent);
  expect({ moneyGetsNoTools, writeupMasked }).toEqual({ moneyGetsNoTools: true, writeupMasked: true });
});

// ---------- control: the ordinary paths really are masked ----------
test("control: the documented card shapes are masked", () => {
  for (const s of ["4111 1111 1111 1111", "4111 1111 1111　1111", "４１１１１１１１１１１１１１１１", "4111​1111‍1111﻿1111", "4111\n1111\n1111\n1111", "CARD#4111111111111111", "ACCT:12345678", "https://x.io/p?c=4111111111111111"]) {
    expect(digitsLeft(maskNumbers(s))).not.toContain("41111111");
    expect(isMasked(maskNumbers(s))).toBe(true);
  }
  expect(() => requestMoneyAsk(db, spaceId, "card ４１１１ １１１１ １１１１ １１１１")).toThrow();
});

// ---------- F7: rows stored by the Plan 10 masker are never re-masked, and re-importing them doubles ----------
test("F7a a row the old masker let through (dot-separated) is still raw after the new engine opens the database", () => {
  // What main's maskNumbers (/\d[\dX*\s-]{4,}\d/) stored for "PAYMENT 4111.1111.1111.1111": unchanged.
  db.query(
    "INSERT INTO money_transactions (id, space_id, source, account, date, description, merchant, amount, currency, kind, symbol, fingerprint, imported_at) VALUES ('mtx_old', ?, 'bank', 'Imported', '2026-09-02', 'PAYMENT 4111.1111.1111.1111', 'Payment', -5, 'CAD', 'spend', NULL, 'fp_old', 1)",
  ).run(spaceId);
  db.close();
  db = openDb();
  const d = (db.query("SELECT description FROM money_transactions WHERE id = 'mtx_old'").get() as { description: string }).description;
  expect(isMasked(d)).toBe(true);
});

test("F7b re-importing a file stored before this branch doubles every row whose description held a date", () => {
  const file = "Date,Description,Amount\n2026-10-02,UBER TRIP 2026-10-01,-12.00";
  // main stored the date as a card number: "UBER TRIP ··1001".
  const p = previewMoney(file);
  importMoney(db, spaceId, { ...p, rows: p.rows.map((r: any) => ({ ...r, description: "UBER TRIP ··1001" })) });
  importMoney(db, spaceId, previewMoney(file));
  expect((db.query("SELECT COUNT(*) AS n FROM money_transactions").get() as { n: number }).n).toBe(1);
});
