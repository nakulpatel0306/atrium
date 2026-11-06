import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../../../src/engine/db";
import { createSpace } from "../../../src/engine/spaces";
import { listTasks } from "../../../src/engine/tasks";
import { categorize, DEFAULT_RULES, listRules, merchantOf, setRules } from "../../../src/engine/money/categories";
import { importMoney, MAX_ROWS, previewMoney } from "../../../src/engine/money/import";
import { moneyFacts, moneyView, requestMoneyAsk } from "../../../src/engine/money/summary";
import { tempHome } from "../../helpers";

const DIR = join(import.meta.dir, "../../fixtures/money");
const csv = (name: string) => readFileSync(join(DIR, name), "utf8");
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

test("an RBC export: dates, both description columns, signed amounts and accounts", () => {
  const p = previewMoney(csv("rbc.csv"));
  expect(p.format).toBe("bank");
  expect(p.signs).toBe("negative-out");
  expect(p.rows).toHaveLength(40);
  expect(p.rows[0]).toMatchObject({ source: "bank", date: "2026-08-01", account: "Chequing ··1234", amount: 3150, merchant: "Payroll Deposit", kind: "income" });
  expect(p.rows.find((r) => r.description.startsWith("LOBLAWS"))).toMatchObject({ amount: -86.42, merchant: "Loblaws", kind: "spend" });
  // Account and card numbers keep their last four digits only.
  expect(p.accounts).toEqual(["Chequing ··1234", "MasterCard ··4021"]);
});

test("a formula in a cell is stored as plain text", () => {
  const row = previewMoney(csv("rbc.csv")).rows.find((r) => r.description.includes("HYPERLINK"))!;
  expect(row.description.startsWith("=")).toBe(false);
  expect(row.description).toBe('HYPERLINK("http://evil.example","click")');
});

test("a Scotiabank card export reads Debit and Credit from its type column", () => {
  const p = previewMoney(csv("scotia-visa.csv"));
  expect(p.rows.map((r) => r.amount)).toEqual([-64.99, -11.99, -4.25, 81.23, -23.5]);
  expect(p.rows[0]).toMatchObject({ merchant: "Amzn Mktp", account: "Imported" });
});

test("a headerless TD export maps date, description, debit and credit", () => {
  const p = previewMoney(csv("td-headerless.csv"));
  expect(p.guessed).toContain("This file has no header row, so Atrium read it as date, description, money out, money in.");
  expect(p.rows.map((r) => [r.date, r.merchant, r.amount])).toEqual([
    ["2026-11-02", "Tim Hortons", -4.85],
    ["2026-11-03", "Costco Wholesale", -182.44],
    ["2026-11-04", "Interac E-trf", 250],
  ]);
});

test("charges written as positive numbers can be flipped", () => {
  const card = "Date,Description,Amount\n2026-10-01,NETFLIX.COM,16.49\n2026-10-03,SPOTIFY,11.99\n2026-10-05,PAYMENT RECEIVED,-28.48\n";
  const guessed = previewMoney(card);
  expect(guessed.signs).toBe("positive-out");
  expect(guessed.rows.map((r) => r.amount)).toEqual([-16.49, -11.99, 28.48]);
  expect(guessed.warnings).toContain("Most amounts are positive, so Atrium read them as money spent. Switch it if that's wrong.");
  expect(previewMoney(card, { signs: "negative-out" }).rows.map((r) => r.amount)).toEqual([16.49, 11.99, -28.48]);
});

test("day-first dates when asked", () => {
  const p = previewMoney("Date,Description,Amount\n03/11/2026,TIM HORTONS,-2.00\n", { dates: "dmy" });
  expect(p.rows[0]!.date).toBe("2026-11-03");
  expect(previewMoney("Date,Description,Amount\n03/11/2026,TIM HORTONS,-2.00\n").rows[0]!.date).toBe("2026-03-11");
});

test("bad rows are skipped with a reason, and a file with nothing usable says what to do", () => {
  const p = previewMoney("Date,Description,Amount\nnot a date,X,1\n2026-10-01,Y,abc\n2026-10-02,Z,-3\n");
  expect(p.rows).toHaveLength(1);
  expect(p.skipped).toEqual([
    { line: 2, reason: "No date Atrium can read." },
    { line: 3, reason: "No amount Atrium can read." },
  ]);
  expect(previewMoney("Name,Colour\nA,Red\n").warnings).toEqual(["Atrium couldn't find date, description and amount columns. Pick them below."]);
});

test("a file over the row cap keeps the first rows and says so", () => {
  const big = ["Date,Description,Amount", ...Array.from({ length: MAX_ROWS + 5 }, (_, i) => `2026-10-01,COFFEE ${i},-1`)].join("\n");
  const p = previewMoney(big);
  expect(p.rows).toHaveLength(MAX_ROWS);
  expect(p.warnings).toContain(`That file has more than ${MAX_ROWS.toLocaleString("en-US")} rows; Atrium imported the first ${MAX_ROWS.toLocaleString("en-US")}.`);
});

test("importing the same file twice adds nothing the second time; identical rows in one file are kept", () => {
  const first = importMoney(db, spaceId, previewMoney(csv("rbc.csv")));
  expect(first).toEqual({ added: 40, duplicates: 0 });
  expect(importMoney(db, spaceId, previewMoney(csv("rbc.csv")))).toEqual({ added: 0, duplicates: 40 });
  const twice = "Date,Description,Amount\n2026-10-01,COFFEE,-2\n2026-10-01,COFFEE,-2\n";
  expect(importMoney(db, spaceId, previewMoney(twice))).toEqual({ added: 2, duplicates: 0 });
});

test("a Wealthsimple activity export becomes deposits, buys, dividends, fees and withdrawals", () => {
  const p = previewMoney(csv("ws-activity-2026.csv"));
  expect(p.format).toBe("wealthsimple");
  expect(p.rows.map((r) => r.kind)).toEqual(["deposit", "buy", "buy", "dividend", "deposit", "dividend", "fee", "sell", "dividend", "withdrawal", "deposit", "dividend"]);
  expect(p.rows[3]).toMatchObject({ account: "TFSA", symbol: "XEQT", amount: 48.75, source: "wealthsimple" });
});

test("merchants and categories", () => {
  expect(merchantOf("UBER* EATS")).toBe("Uber Eats");
  expect(merchantOf("ROGERS ******1234")).toBe("Rogers");
  expect(merchantOf("BEST BUY #921")).toBe("Best Buy");
  expect(merchantOf("SPOTIFY P2F1A9")).toBe("Spotify");
  expect(categorize("LOBLAWS #1234", DEFAULT_RULES)).toBe("Groceries");
  expect(categorize("NETFLIX.COM", DEFAULT_RULES)).toBe("Subscriptions");
  expect(categorize("PAYMENT - THANK YOU", DEFAULT_RULES)).toBe("Transfers");
  expect(categorize("SOMETHING ELSE", DEFAULT_RULES)).toBe("Other");
});

test("rules are seeded once, editable, and validated", () => {
  expect(listRules(db, spaceId)).toHaveLength(DEFAULT_RULES.length);
  setRules(db, spaceId, [{ match: "best buy", category: "Electronics" }]);
  expect(listRules(db, spaceId)).toEqual([{ match: "best buy", category: "Electronics" }]);
  setRules(db, spaceId, []);
  expect(listRules(db, spaceId)).toEqual([]);
  expect(() => setRules(db, spaceId, [{ match: " ", category: "X" }])).toThrow("Each rule needs words to match and a category.");
});

test("the month's spending by category, recurring charges and unusual ones", () => {
  importMoney(db, spaceId, previewMoney(csv("rbc.csv")));
  const v = moneyView(db, spaceId, NOW, "2026-10");
  expect(v.month).toBe("2026-10");
  expect(v.months).toEqual(["2026-11", "2026-10", "2026-09", "2026-08"]);
  const cats = Object.fromEntries(v.spending.map((s) => [s.category, s.amount]));
  expect(cats.Groceries).toBeCloseTo(91.33 + 312.4, 2);
  expect(cats.Subscriptions).toBeCloseTo(16.49 + 11.99 + 29.99, 2);
  expect(cats.Shopping).toBeCloseTo(899.98, 2);
  expect(cats.Transfers).toBeUndefined();
  expect(v.income).toBeCloseTo(6300, 2);
  // Fixed amounts about a month apart; Uber Eats and Loblaws vary too much to count.
  expect(v.recurring.map((r) => r.merchant).sort()).toEqual(["Adobe Creative", "E-transfer Sent", "Netflix.com", "Rogers", "Spotify"]);
  expect(v.recurring.find((r) => r.merchant === "Netflix.com")).toMatchObject({ amount: 16.49, count: 3, last: "2026-10-06", next: "2026-11-06" });
  expect(v.unusual).toEqual([
    { date: "2026-10-27", merchant: "Metro", amount: 312.4, reason: "More than 3× your usual at Metro." },
    { date: "2026-10-26", merchant: "Best Buy", amount: 449.99, reason: "Same amount at Best Buy within 3 days." },
  ]);
  expect(moneyView(db, spaceId, NOW).month).toBe("2026-11");
});

test("Wealthsimple totals by year and TFSA deposits", () => {
  importMoney(db, spaceId, previewMoney(csv("ws-activity-2026.csv")));
  const y = moneyView(db, spaceId, NOW).ws.find((w) => w.year === "2026")!;
  // CAD and USD activity are kept apart; nothing is converted without a rate.
  expect(y).toMatchObject({ deposits: 9000, tfsaDeposits: 7000, withdrawals: 500, dividends: 156.25, fees: 1.5, buys: 4680, sells: 0, usd: { buys: 1150, sells: 280, dividends: 0 } });
});

test("the facts Claude gets are compact and say where they come from", () => {
  importMoney(db, spaceId, previewMoney(csv("rbc.csv")));
  importMoney(db, spaceId, previewMoney(csv("ws-activity-2026.csv")));
  const facts = moneyFacts(db, spaceId, NOW).join("\n");
  expect(facts).toContain("Wealthsimple 2026: deposits CA$9,000.00 (TFSA CA$7,000.00), withdrawals CA$500.00, dividends CA$156.25, fees CA$1.50, buys CA$4,680.00 + US$1,150.00, sells US$280.00.");
  expect(facts).toContain("Recurring charges:");
  expect(facts).toContain("Netflix.com CA$16.49 monthly");
  expect(facts).toContain("Bank and card: 40 transactions from 2026-08-01 to 2026-11-04 in Chequing ··1234 and MasterCard ··4021.");
  expect(Buffer.byteLength(facts)).toBeLessThan(4000);
  expect(facts).not.toContain("5191XXXXXXXX4021");
});

test("Ask about my money queues one read-only Claude task", () => {
  expect(() => requestMoneyAsk(db, spaceId, "  ")).toThrow("Type a question, like How much did I get in dividends this year?");
  const t = requestMoneyAsk(db, spaceId, "Where did my money go last month?");
  expect(t).toMatchObject({ agent: "claude", purpose: "money", title: "Ask Claude about my money", detail: "Where did my money go last month?" });
  expect(() => requestMoneyAsk(db, spaceId, "Again?")).toThrow("Claude is already looking at your money.");
  expect(() => requestMoneyAsk(db, spaceId, "x".repeat(501))).toThrow();
  expect(listTasks(db).filter((x) => x.purpose === "money")).toHaveLength(1);
});

// ---- Final-review fixes ----

test("Claude's money facts never carry more than the last four digits of a card or account number", () => {
  const csv = ["Date,Description,Amount,Card Number", "2026-10-02,LOBLAWS,-20.00,4510 1234 5678 9012", "2026-10-03,PAYMENT TO 00123456789,-50.00,4510 1234 5678 9012"].join("\n");
  importMoney(db, spaceId, previewMoney(csv));
  const stored = db.query("SELECT account, description FROM money_transactions ORDER BY date").all() as { account: string; description: string }[];
  expect(stored[0]!.account).toBe("··9012");
  expect(stored[1]!.description).toBe("PAYMENT TO ··6789");
  const facts = moneyFacts(db, spaceId, Date.UTC(2026, 9, 15)).join("\n");
  expect(facts).toContain("··9012");
  for (const part of ["4510", "1234", "5678", "00123456789"]) expect(facts).not.toContain(part);
});

test("the money summary stays fast on one 20,000-row file and keeps its worth-a-look list short", () => {
  const lines = ["Date,Description,Amount"];
  for (let i = 0; i < 20000; i++) lines.push(new Date(Date.UTC(2026, 7, 1) + (i % 90) * 86400000).toISOString().slice(0, 10) + ",STARBUCKS " + i + ",-5.25");
  importMoney(db, spaceId, previewMoney(lines.join("\n")));
  const t = performance.now();
  const v = moneyView(db, spaceId, Date.UTC(2026, 9, 15));
  expect(performance.now() - t).toBeLessThan(500);
  expect(v.unusual.length).toBeLessThanOrEqual(10);
  expect(new Set(v.unusual.map((u) => `${u.date}|${u.merchant}|${u.amount}|${u.reason}`)).size).toBe(v.unusual.length);
}, 60000);

test("worth a look ranks the most unusual first", () => {
  const rows = ["Date,Description,Amount"];
  for (const [d, a] of [["2026-09-01", "-10"], ["2026-09-08", "-11"], ["2026-09-15", "-10"], ["2026-09-22", "-45"], ["2026-09-29", "-200"]]) rows.push(`${d},CORNER STORE,${a}`);
  importMoney(db, spaceId, previewMoney(rows.join("\n")));
  expect(moneyView(db, spaceId, NOW).unusual.map((u) => u.amount)).toEqual([200, 45]);
});

test("a CA$- or US$-prefixed amount is read", () => {
  const p = previewMoney(["Date,Description,Amount", '2026-10-02,LOBLAWS,"-CA$20.00"', "2026-10-03,LOBLAWS,CA$-21.50", "2026-10-04,AMAZON,-US$5"].join("\n"));
  expect(p.skipped).toEqual([]);
  expect(p.rows.map((r) => r.amount)).toEqual([-20, -21.5, -5]);
});

test("a formula trigger is stripped even after a leading space, and a leading minus too", () => {
  const p = previewMoney(["Date,Description,Amount", '2026-10-02," =HYPERLINK(""x"")",-1', "2026-10-03,-cmd|calc,-1"].join("\n"));
  expect(p.rows.map((r) => r.description)).toEqual(['HYPERLINK("x")', "cmd|calc"]);
  const ws = previewMoney(["transaction_date,account_type,activity_type,activity_sub_type,symbol,name,currency,net_cash_amount", '2026-01-05,TFSA,Dividend,,," =1+1",CAD,5'].join("\n"));
  expect(ws.rows[0]!.merchant.startsWith("=")).toBe(false);
});

test("an impossible date is skipped", () => {
  const p = previewMoney("Date,Description,Amount\n2026-02-31,X,-1\n02/30/2026,Y,-1\n2026-02-28,Z,-1\n");
  expect(p.rows.map((r) => r.date)).toEqual(["2026-02-28"]);
  expect(p.skipped.map((s) => s.reason)).toEqual(["No date Atrium can read.", "No date Atrium can read."]);
});

test("one transaction reads as one", () => {
  importMoney(db, spaceId, previewMoney("Date,Description,Amount\n2026-10-02,LOBLAWS,-20\n"));
  expect(moneyFacts(db, spaceId, NOW).join("\n")).toContain("Bank and card: 1 transaction from 2026-10-02 to 2026-10-02");
});
