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
  expect(p.guessed).toContain("TD files have no header row, so Atrium read it as date, description, money out, money in, balance.");
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
  // It opens on the latest month the imports fully cover, not two days of November.
  expect(moneyView(db, spaceId, NOW).month).toBe("2026-10");
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
  expect(facts).toContain("Bank and card: 40 transactions from Aug 1, 2026 to Nov 4, 2026 in Chequing ··1234 and MasterCard ··4021.");
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
  expect(moneyFacts(db, spaceId, NOW).join("\n")).toContain("Bank and card: 1 transaction from Oct 2, 2026 to Oct 2, 2026");
});

// ---- Plan 14 ----

test("masking keeps dates written in a description and still hides card and account numbers", () => {
  const { maskNumbers } = require("../../../src/engine/money/import") as typeof import("../../../src/engine/money/import");
  expect(maskNumbers("PAYMENT 2026-10-02")).toBe("PAYMENT 2026-10-02");
  expect(maskNumbers("REFUND 10/02/2026 ONLINE")).toBe("REFUND 10/02/2026 ONLINE");
  expect(maskNumbers("BILL 2026/10/02")).toBe("BILL 2026/10/02");
  expect(maskNumbers("From 2026-10-01 to 2026-10-30.")).toBe("From 2026-10-01 to 2026-10-30.");
  expect(maskNumbers("TRF 02-10-2026")).toBe("TRF 02-10-2026");
  expect(maskNumbers("CARD 4510 1234 5678 9012")).toBe("CARD ··9012");
  expect(maskNumbers("ACCT 00123456789")).toBe("ACCT ··6789");
  expect(maskNumbers("REF 123456")).toBe("REF ··3456");
  expect(maskNumbers("TIM HORTONS #4410")).toBe("TIM HORTONS #4410");
  // A run that only looks like a date's digits, without a date's shape, is still a number.
  expect(maskNumbers("ID 20261002")).toBe("ID ··1002");
  // A number right next to a date takes the date with it: masking errs towards hiding.
  expect(maskNumbers("PAYMENT 2026-10-02 4510123456789012")).toBe("PAYMENT ··9012");
  expect(maskNumbers("5191XXXXXXXX4021")).toBe("··4021");
  // Not a real date, so it's masked.
  expect(maskNumbers("X 2026-19-45")).toBe("X ··1945");
  // Security review: separators can't make a card number look like a date.
  expect(maskNumbers("CARD 4510-1234-5678-9012")).toBe("CARD ··9012");
  expect(maskNumbers("CARD 4510.1234.5678.9012")).toBe("CARD ··9012");
  expect(maskNumbers("CARD 4510/1234/5678/9012")).toBe("CARD ··9012");
  expect(maskNumbers("CARD 4510.12.31")).toBe("CARD ··1231");
  expect(maskNumbers("CARD 4510-12-31 7788")).toBe("CARD ··7788");
  // Text that already holds a private-use character can't confuse the restore.
  expect(maskNumbers("\uE000 PAYMENT 2026-10-02 \uE000 4510123456789012")).toBe("\uE000 PAYMENT ··9012");
  // Digits split around a kept date that add up to a long run mask everything.
  expect(maskNumbers("ACCT 123 2026-10-02 456")).not.toMatch(/2026-10-02/);
});

test("a TD chequing export is detected with medium confidence and named TD chequing", () => {
  const p = previewMoney(csv("td-chequing.csv"));
  expect(p.bank).toMatchObject({ id: "td", label: "TD", confidence: "medium" });
  expect(p.account).toBe("TD chequing");
  expect(p.accounts).toEqual(["TD chequing"]);
  expect(p.rows[0]).toMatchObject({ date: "2026-08-01", amount: -1650, account: "TD chequing" });
  expect(p.rows.find((r) => r.description.startsWith("PAYROLL"))!.amount).toBe(2150);
});

test("a TD credit card export is told apart by its card payments", () => {
  const p = previewMoney(csv("td-credit.csv"));
  expect(p.bank.id).toBe("td");
  expect(p.account).toBe("TD credit card");
  expect(p.rows.find((r) => r.description === "PAYMENT - THANK YOU")!.amount).toBe(612.4);
  expect(p.rows.find((r) => r.description.startsWith("SPOTIFY"))!.amount).toBe(-11.99);
  // Nakul can pick the account himself.
  expect(previewMoney(csv("td-credit.csv"), { account: "TD chequing" }).accounts).toEqual(["TD chequing"]);
});

test("an Amex Canada export: positive amounts are charges, month-name dates are read", () => {
  const p = previewMoney(csv("amex.csv"));
  expect(p.bank).toMatchObject({ id: "amex", label: "Amex", confidence: "high" });
  expect(p.account).toBe("Amex");
  expect(p.signs).toBe("positive-out");
  expect(p.warnings).toEqual([]);
  expect(p.rows[0]).toMatchObject({ date: "2026-08-06", description: "NETFLIX.COM", amount: -16.49, account: "Amex" });
  expect(p.rows.find((r) => r.description.startsWith("PAYMENT"))!.amount).toBe(402.11);
  expect(previewMoney("Date,Description,Amount\n05 Nov. 2026,NETFLIX.COM,16.49\n\"Nov 07, 2026\",SPOTIFY,11.99\n").rows.map((r) => r.date)).toEqual(["2026-11-05", "2026-11-07"]);
});

test("a bare Date, Description, Amount file with charges as positives looks like Amex, with less confidence", () => {
  const p = previewMoney("Date,Description,Amount\n2026-10-01,NETFLIX.COM,16.49\n2026-10-03,SPOTIFY,11.99\n");
  expect(p.bank).toMatchObject({ id: "amex", confidence: "medium" });
  expect(previewMoney("Date,Description,Amount\n2026-10-01,COFFEE,-4\n2026-10-03,PAY,-11.99\n").bank.id).toBe("generic");
});

test("a Wealthsimple savings statement: interest is money in; AFT is money in or out until it pairs with his own account", () => {
  const p = previewMoney(csv("ws-cash.csv"));
  expect(p.bank).toMatchObject({ id: "ws-cash", label: "Wealthsimple savings", confidence: "medium" });
  expect(p.format).toBe("bank");
  expect(p.rows[0]).toMatchObject({ date: "2026-08-17", amount: 500, kind: "income", account: "Wealthsimple savings", source: "bank" });
  const trf = previewMoney('"date","transaction","description","amount","balance"\n"2026-10-04","TRFIN","From your other Wealthsimple account","10.00","10.00"\n');
  expect(trf.rows[0]!.kind).toBe("transfer");
  expect(p.rows[1]).toMatchObject({ kind: "interest", description: "Interest" });
});

test("other layouts keep the old detection and the manual mapping", () => {
  expect(previewMoney(csv("rbc.csv")).bank).toMatchObject({ id: "generic", confidence: "low" });
  expect(previewMoney(csv("ws-activity-2026.csv")).bank).toMatchObject({ id: "ws-activity", confidence: "high" });
});

test("re-importing a file that was stored as Imported before doesn't double it", () => {
  importMoney(db, spaceId, previewMoney(csv("td-headerless.csv"), { account: "Imported" }));
  expect(importMoney(db, spaceId, previewMoney(csv("td-headerless.csv")))).toEqual({ added: 0, duplicates: 3 });
});

test("each import records which account it covered and its dates", () => {
  importMoney(db, spaceId, previewMoney(csv("amex.csv")));
  expect(db.query("SELECT account, first_date, last_date, rows FROM money_imports").all()).toEqual([{ account: "Amex", first_date: "2026-08-06", last_date: "2026-10-28", rows: 20 }]);
});

// ---- Card data ----
import { isMasked, maskNumbers as mask } from "../../../src/engine/money/import";

test("card data: 12 to 19 digit runs are masked with spaces, dashes or dots, keeping the last 4", () => {
  for (const card of ["4111111111111111", "4111 1111 1111 1111", "4111-1111-1111-1111", "4111.1111.1111.1111", "411111111111", "4111111111111111111", "3782 822463 10005"]) {
    const out = mask(`PAID ${card} THANKS`);
    expect(out).toBe(`PAID ··${card.replace(/\D/g, "").slice(-4)} THANKS`);
    expect(isMasked(out)).toBe(true);
  }
});

test("card data: SIN-like and named account or transit numbers are masked; dates and amounts stay", () => {
  expect(mask("SIN 046-454-286")).toBe("SIN ··4286");
  expect(mask("ACCT 12345")).toBe("ACCT ··2345");
  expect(mask("account: 98765 transit 00412")).toBe("account: ··8765 transit ··0412");
  expect(mask("DEPOSIT #55123")).toBe("DEPOSIT #··5123");
  expect(mask("TFR 2026-10-02 FOR 1234.56")).toBe("TFR 2026-10-02 FOR 1234.56");
  // Only dates, money amounts and short numbers are kept; anything else with 6+ digits is hidden.
  expect(mask("Nakul holds 0.123456 of XEQT")).toBe("Nakul holds ··3456 of XEQT");
  expect(mask("PAID 12.50 123456")).toBe("PAID ··3456");
});

test("card data at rest: no full card or account number reaches the database file or its WAL", () => {
  const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
  const bank = ["Date,Description,Amount,Account Number", "2026-10-02,PAYMENT 4111 1111 1111 1111 REF 2026-10-02,-20.00,5500-0000-0000-0004", "2026-10-03,TRANSFER ACCT 77777123,-50.00,5500-0000-0000-0004"].join("\n");
  const ws = ["transaction_date,account_type,activity_type,activity_sub_type,symbol,name,currency,net_cash_amount", "2026-01-05,TFSA 4012888888881881,MoneyMovement,DEPOSIT,,From 4111-1111-1111-1111,CAD,5"].join("\n");
  const cash = ['"date","transaction","description","amount","balance"', '"2026-10-04","AFT_IN","From 4111.1111.1111.1111","10.00","10.00"'].join("\n");
  for (const text of [bank, ws, cash]) importMoney(db, spaceId, previewMoney(text));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const full = join(dir, f);
      if (statSync(full).isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(home.home);
  expect(files.some((f) => f.endsWith("-wal"))).toBe(true);
  const raw = files.map((f) => readFileSync(f).toString("latin1")).join("\n");
  for (const secret of ["4111111111111111", "4111 1111 1111 1111", "4111-1111-1111-1111", "4111.1111.1111.1111", "5500-0000-0000-0004", "5500000000000004", "4012888888881881", "77777123"]) {
    expect(raw.includes(secret)).toBe(false);
  }
  const stored = db.query("SELECT account, description, merchant FROM money_transactions").all() as Record<string, string>[];
  for (const r of stored) for (const v of Object.values(r)) expect(isMasked(v)).toBe(true);
  expect(stored.some((r) => r.description!.includes("2026-10-02"))).toBe(true);
});

test("money imported before imports were recorded gets one coverage row per account", () => {
  const { backfillMoneyImports } = require("../../../src/engine/db") as typeof import("../../../src/engine/db");
  importMoney(db, spaceId, previewMoney(csv("rbc.csv")));
  db.query("DELETE FROM money_imports").run();
  backfillMoneyImports(db);
  expect(db.query("SELECT account, first_date, last_date, rows FROM money_imports ORDER BY account").all()).toEqual([
    { account: "Chequing ··1234", first_date: "2026-08-01", last_date: "2026-11-02", rows: 21 },
    { account: "MasterCard ··4021", first_date: "2026-08-06", last_date: "2026-11-04", rows: 19 },
  ]);
});

// ---- Transfers ----
import { markTransfer, transfers } from "../../../src/engine/money/transfers";
const importAll = () => {
  for (const f of ["td-chequing.csv", "td-credit.csv", "amex.csv", "ws-cash.csv"]) importMoney(db, spaceId, previewMoney(csv(f)));
};
const txIdOf = (description: string, date: string) => (db.query("SELECT id FROM money_transactions WHERE description = ? AND date = ?").get(description, date) as { id: string }).id;

test("paying the cards and topping up Wealthsimple Cash are transfers, not spending or money in", () => {
  importAll();
  const v = moneyView(db, spaceId, NOW, "2026-10");
  const cats = Object.fromEntries(v.spending.map((s) => [s.category, s.amount]));
  expect(cats.Transfers).toBeUndefined();
  expect(v.spending.reduce((n, c) => n + c.amount, 0)).toBeCloseTo(v.spent, 2);
  // Two paydays plus Wealthsimple interest; none of the card payments or the CA$500 top-up.
  const interest = (db.query("SELECT amount FROM money_transactions WHERE description = 'Interest' AND date LIKE '2026-10%'").get() as { amount: number }).amount;
  expect(v.income).toBeCloseTo(4300 + interest, 2);
  expect(v.spent).toBeLessThan(4000);
});

test("transfers: known descriptions, matching pairs across accounts (3 days if one side says so, else 1), and Nakul's own marks", () => {
  const rows = [
    { id: "a", date: "2026-10-10", account: "TD chequing", description: "ONLINE TFR", amount: -300, kind: "spend", transfer: null },
    { id: "b", date: "2026-10-11", account: "Wealthsimple Cash", description: "Deposit", amount: 300, kind: "income", transfer: null },
    // The same amount 2 days apart with nothing saying it's a transfer: not paired.
    { id: "i", date: "2026-10-15", account: "TD chequing", description: "STORE", amount: -77, kind: "spend", transfer: null },
    { id: "j", date: "2026-10-17", account: "Amex", description: "REFUND", amount: 77, kind: "income", transfer: null },
    { id: "c", date: "2026-10-10", account: "TD chequing", description: "COFFEE", amount: -300, kind: "spend", transfer: null },
    { id: "d", date: "2026-10-20", account: "Amex", description: "PAYMENT RECEIVED - THANK YOU", amount: 90, kind: "income", transfer: null, flow: "card-payment" as const },
    { id: "e", date: "2026-10-01", account: "TD chequing", description: "REFUND", amount: 40, kind: "income", transfer: null },
    { id: "f", date: "2026-10-09", account: "TD credit card", description: "STORE", amount: -40, kind: "spend", transfer: null },
    { id: "g", date: "2026-10-03", account: "TD chequing", description: "WEALTHSIMPLE", amount: -25, kind: "spend", transfer: 0 },
    { id: "h", date: "2026-10-03", account: "TD chequing", description: "CASH TO SAVINGS", amount: -25, kind: "spend", transfer: 1 },
  ];
  const t = transfers(rows);
  expect(Object.fromEntries(t)).toEqual({ a: "pair", b: "pair", d: "card-payment", h: "marked" });
});

test("marking a transaction as a transfer or not changes the month, and the mark can be handed back", () => {
  importAll();
  const before = moneyView(db, spaceId, NOW, "2026-10").spent;
  const id = txIdOf("BEST BUY #921", "2026-10-26");
  markTransfer(db, spaceId, id, true);
  expect(moneyView(db, spaceId, NOW, "2026-10").spent).toBeCloseTo(before - 749.99, 2);
  markTransfer(db, spaceId, id, null);
  expect(moneyView(db, spaceId, NOW, "2026-10").spent).toBeCloseTo(before, 2);
  const pay = txIdOf("AMEX BILL PYMT", "2026-10-22");
  markTransfer(db, spaceId, pay, false);
  expect(moneyView(db, spaceId, NOW, "2026-10").spent).toBeCloseTo(before + 1124.3, 2);
  expect(() => markTransfer(db, spaceId, "mtx_nope", true)).toThrow("That transaction isn't here anymore. Refresh the page.");
});

test("card data at rest: a card number in every column and in the account option is never written", () => {
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  const card = "4111 1111 1111 1111";
  const files = [
    `Date,Description 1,Description 2,Amount,Account Type,Account Number,Type\n2026-10-02,${card},${card},-5.00,${card},${card},Debit`,
    `Date,Description,Amount\n2026-10-02,${card},5.00`,
    `transaction_date,account_type,activity_type,activity_sub_type,symbol,name,currency,net_cash_amount\n2026-01-05,${card},Dividend,,${card},${card},CAD,5`,
    `"date","transaction","description","amount","balance"\n"2026-10-04","${card}","","10.00","10.00"`,
    `10/02/2026,${card},5.00,,100.00`,
  ];
  for (const f of files) {
    importMoney(db, spaceId, previewMoney(f));
    importMoney(db, spaceId, previewMoney(f, { account: `Visa ${card}` }));
  }
  const accounts = (db.query("SELECT DISTINCT account FROM money_transactions").all() as { account: string }[]).map((r) => r.account);
  expect(accounts).toContain("Visa ··1111");
  const raw = readdirSync(home.home)
    .filter((f) => f.includes(".db") || f.endsWith("-wal") || f.endsWith("-shm"))
    .map((f) => readFileSync(join(home.home, f)).toString("latin1"))
    .join("\n");
  expect(raw.length).toBeGreaterThan(0);
  for (const secret of [card, card.replace(/ /g, ""), "1111 1111 1111"]) expect(raw.includes(secret)).toBe(false);
  for (const r of db.query("SELECT account, description, merchant, symbol FROM money_transactions").all() as Record<string, string | null>[]) {
    for (const v of Object.values(r)) if (v) expect(isMasked(v)).toBe(true);
  }
});

test("storeRow masks every text field, however the row was built", () => {
  const { storeRow } = require("../../../src/engine/money/import") as typeof import("../../../src/engine/money/import");
  const r = storeRow({ source: "bank", account: "4111111111111111", date: "2026-10-02", description: "=4111-1111-1111-1111", merchant: "4111 1111 1111 1111", amount: -1, currency: "CAD", kind: "spend", symbol: "4111111111111111" });
  expect(r).toMatchObject({ account: "··1111", description: "··1111", merchant: "··1111", symbol: "··1111" });
});

// ---- Recap ----
import { coverText, recap, recapFacts } from "../../../src/engine/money/recap";
import { monthCover } from "../../../src/engine/money/coverage";

test("the recap: spent, money in, net, against last month, with the biggest changes and notable charges", () => {
  importAll();
  const r = recap(db, spaceId, NOW, "2026-10")!;
  const sept = recap(db, spaceId, NOW, "2026-09")!;
  expect(r.previous).toBe("2026-09");
  expect(r.before).toEqual({ spent: sept.spent, income: sept.income });
  expect(r.net).toBeCloseTo(r.income - r.spent, 2);
  const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  expect(r.lines[0]).toBe(`You spent CA$${money(r.spent)} in October, CA$${money(r.spent - sept.spent)} more than September.`);
  expect(r.lines[1]).toMatch(/^Money in was CA\$4,3\d\d\.\d\d, so CA\$[\d,.]+ was left over\.$/);
  expect(r.changes[0]).toMatchObject({ category: "Shopping", before: 0, delta: 814.19 });
  expect(r.changes.length).toBeLessThanOrEqual(3);
  expect(r.notable[0]).toMatchObject({ merchant: "Best Buy", amount: 749.99 });
  expect(r.notable.length).toBeLessThanOrEqual(3);
  expect(r.basis).toEqual({ count: expect.any(Number), from: "2026-10-01", to: "2026-10-30" });
  // The TD card payment both ways, the Amex payment both ways and the Wealthsimple top-up both ways.
  expect(r.moved.count).toBe(6);
  expect(r.cover.complete).toBe(true);
  expect(coverText(r.cover)).toBeNull();
  expect(recap(db, spaceId, NOW, "2026-12")).toBeNull();
});

test("a month the imports don't fully cover says so, and the month in progress says so", () => {
  importMoney(db, spaceId, previewMoney("Date,Description,Amount\n2026-10-01,COFFEE,-4\n2026-10-31,COFFEE,-4\n2026-11-02,COFFEE,-4\n", { account: "Amex", signs: "negative-out" }));
  importMoney(db, spaceId, previewMoney("Date,Description,Amount\n2026-10-02,LUNCH,-14\n2026-10-12,LUNCH,-14\n", { account: "TD chequing", signs: "negative-out" }));
  const oct = monthCover(db, spaceId, "2026-10", "2026-11-05");
  expect(oct.complete).toBe(false);
  expect(oct.accounts).toEqual([
    { account: "Amex", complete: true, through: "2026-10-31" },
    { account: "TD chequing", complete: false, through: "2026-10-12" },
  ]);
  expect(coverText(oct)).toBe("Incomplete: TD chequing only through Oct 12.");
  const nov = monthCover(db, spaceId, "2026-11", "2026-11-05");
  expect(nov.inProgress).toBe(true);
  expect(coverText(nov)).toBe("November isn't over yet.");
  expect(recap(db, spaceId, NOW, "2026-11")!.lines[0]).toBe("You spent CA$4.00 in November so far, CA$32.00 less than October.");
});

test("the facts Claude gets for Explain my month are Atrium's numbers only, masked", () => {
  importAll();
  importMoney(db, spaceId, previewMoney("Date,Description,Amount\n2026-10-29,GIFT SHOP 4111 1111 1111 1111,-900\n", { account: "Amex", signs: "negative-out" }));
  const facts = recapFacts(recap(db, spaceId, NOW, "2026-10")!).join("\n");
  expect(facts).toContain("Recap facts for October 2026");
  expect(facts).toContain("Shopping up CA$814.19");
  expect(facts).toContain("Based on ");
  expect(isMasked(facts)).toBe(true);
  expect(facts).not.toContain("4111");
});

// ---- Subscriptions ----
import { subscriptions } from "../../../src/engine/money/subscriptions";
import { counted, txs } from "../../../src/engine/money/rows";

test("subscriptions: every recurring charge with its cost, last and next dates, and its flags; rent and bills apart", () => {
  importAll();
  const s = subscriptions(counted(txs(db, spaceId, "bank")), listRules(db, spaceId));
  const by = Object.fromEntries(s.list.map((x) => [x.merchant, x]));
  expect(Object.keys(by).sort()).toEqual(["Apple.com/bill", "Crave", "Netflix.com", "Presto Fare/toronto", "Spotify", "Summit Fitness", "Uber One"]);
  expect(s.bills.list.map((x) => x.merchant)).toEqual(["Landlord Pap", "Rogers"]);
  expect(s.bills.perMonth).toBe(1715);
  expect(by.Spotify).toMatchObject({ cadence: "monthly", amount: 12.99, was: 11.99, last: "2026-10-05", next: "2026-11-05", count: 3 });
  expect(by.Spotify!.flags).toContain("price-up");
  // Three months of data is too short for "maybe forgotten".
  expect(s.list.some((x) => x.flags.includes("forgotten"))).toBe(false);
  expect(by.Crave).toMatchObject({ count: 1, flags: ["new"], next: "2026-11-09" });
  expect(s.perMonth).toBeCloseTo(s.list.reduce((n, x) => n + x.perMonth, 0), 2);
  expect(s.perYear).toBeCloseTo(s.perMonth * 12, 2);
});

test("maybe forgotten: small, running over 3 months, nothing else from that merchant; never a big charge", () => {
  const rows = ["Date,Description,Amount"];
  for (const m of ["05", "06", "07", "08", "09", "10"]) rows.push(`2026-${m}-03,SUMMIT FITNESS,-54.99`, `2026-${m}-04,SOUNDCLOUD,-9.99`, `2026-${m}-05,STORAGE UNIT,-249.00`);
  rows.push("2026-10-20,UBER TRIP,-12", "2026-09-20,UBER TRIP,-12");
  importMoney(db, spaceId, previewMoney(rows.join("\n"), { signs: "negative-out" }));
  const s = subscriptions(counted(txs(db, spaceId, "bank")), listRules(db, spaceId));
  const flags = Object.fromEntries([...s.list, ...s.bills.list].map((x) => [x.merchant, x.flags]));
  expect(flags.Soundcloud).toEqual(["forgotten"]);
  expect(flags["Summit Fitness"]).toEqual([]);
  expect(s.bills.list.map((x) => x.merchant)).toEqual(["Storage Unit"]);
});

test("subscriptions: a yearly charge counts as a twelfth a month, and a stopped one drops off", () => {
  const rows = ["Date,Description,Amount", "2024-10-03,ADOBE ANNUAL,-239.88", "2025-10-03,ADOBE ANNUAL,-239.88", "2026-01-05,OLDGYM,-30", "2026-02-05,OLDGYM,-30", "2026-03-05,OLDGYM,-30", "2026-10-20,COFFEE,-4"];
  importMoney(db, spaceId, previewMoney(rows.join("\n"), { signs: "negative-out" }));
  const s = subscriptions(counted(txs(db, spaceId, "bank")), listRules(db, spaceId));
  expect(s.list.map((x) => [x.merchant, x.cadence, x.perMonth, x.next])).toEqual([["Adobe Annual", "yearly", 19.99, "2026-10-03"]]);
  expect(s.perYear).toBe(239.88);
});

// ---- TFSA room ----
import { roomTie, tfsaRoom } from "../../../src/engine/money/room";
import { addEntry, setRoom } from "../../../src/engine/markets/tfsa";

test("TFSA room: says what to enter or import when it can't tell", () => {
  expect(tfsaRoom(db, spaceId, 2026)).toMatchObject({ left: null, source: "none", headline: "Your 2026 TFSA room isn't set yet.", todo: "Enter your Jan 1 room from CRA My Account." });
  setRoom(db, 2026, 7000);
  expect(tfsaRoom(db, spaceId, 2026)).toMatchObject({ left: 7000, source: "none", todo: "Import your Wealthsimple activity export so this year's deposits count." });
});

test("TFSA room: imported Wealthsimple TFSA deposits count, hand-logged entries only when there are none", () => {
  setRoom(db, 2026, 9500);
  addEntry(db, { date: "2026-02-01", kind: "contribution", amount: 1000 });
  expect(tfsaRoom(db, spaceId, 2026)).toMatchObject({ source: "logged", contributed: 1000, left: 8500, from: "CA$9,500.00 on Jan 1 (you entered it) minus CA$1,000.00 contributed (entries you logged)." });
  importMoney(db, spaceId, previewMoney(csv("ws-activity-2026.csv")));
  const r = tfsaRoom(db, spaceId, 2026);
  expect(r).toMatchObject({
    source: "imported",
    contributed: 7000,
    left: 2500,
    headline: "CA$2,500.00 of TFSA room left for 2026.",
    todo: "CA$1,000.00 you logged by hand isn't added, so nothing counts twice. If it went to a TFSA outside Wealthsimple, your room is that much lower.",
  });
  expect(r.from).toMatch(/^CA\$9,500\.00 on Jan 1 \(you entered it\) minus CA\$7,000\.00 deposited \(your Wealthsimple activity, through [A-Z][a-z]{2} \d+\)\.$/);
  expect(roomTie(1234.5, "October", r)).toBe("You had CA$1,234.50 left over in October. You have CA$2,500.00 of TFSA room for 2026.");
  expect(roomTie(-5, "October", r)).toBeNull();
  setRoom(db, 2026, 6000);
  expect(tfsaRoom(db, spaceId, 2026)).toMatchObject({ over: 1000, headline: "Over your 2026 TFSA room by CA$1,000.00.", todo: "CRA charges 1% a month on the excess until it's withdrawn." });
});

// ---- Budgets, nudges and the monthly reminder ----
import { budgetRows, checkBudgets, listBudgets, setBudget } from "../../../src/engine/money/budgets";
import { activeNudges, dismissNudge } from "../../../src/engine/money/nudges";
import { importReminder, moneyDaily } from "../../../src/engine/money/reminder";

const nudgeRows = () => db.query("SELECT kind, key, title, body FROM money_nudges ORDER BY rowid").all() as { kind: string; key: string; title: string; body: string }[];

test("budgets: set inline, changed and removed, and checked against the month", () => {
  setBudget(db, spaceId, "Dining", 400);
  setBudget(db, spaceId, "Groceries", 450.5);
  setBudget(db, spaceId, "Dining", 380);
  expect(listBudgets(db, spaceId)).toEqual([{ category: "Dining", limit: 380 }, { category: "Groceries", limit: 450.5 }]);
  setBudget(db, spaceId, "Groceries", null);
  expect(listBudgets(db, spaceId)).toEqual([{ category: "Dining", limit: 380 }]);
  expect(() => setBudget(db, spaceId, "Dining", -1)).toThrow("Use an amount like 400.");
  expect(() => setBudget(db, spaceId, " ", 5)).toThrow("Pick a category for this budget.");
  expect(budgetRows([{ category: "Dining", limit: 200 }], [{ category: "Dining", amount: 150 }])).toEqual([{ category: "Dining", limit: 200, spent: 150, pct: 75 }]);
});

test("budget heads-ups: once at 80% and once at 100% per category per month, never twice", () => {
  const at = Date.parse("2026-10-20T15:00:00Z");
  setBudget(db, spaceId, "Dining", 100);
  importMoney(db, spaceId, previewMoney("Date,Description,Amount\n2026-10-02,STARBUCKS,-85\n", { signs: "negative-out" }));
  expect(checkBudgets(db, spaceId, at)).toBe(1);
  expect(checkBudgets(db, spaceId, at)).toBe(0);
  importMoney(db, spaceId, previewMoney("Date,Description,Amount\n2026-10-09,TIM HORTONS,-30\n", { signs: "negative-out" }));
  expect(checkBudgets(db, spaceId, at)).toBe(1);
  expect(checkBudgets(db, spaceId, at)).toBe(0);
  expect(nudgeRows()).toEqual([
    { kind: "budget", key: "budget:2026-10:Dining:80", title: "Dining is at 85% of its October budget", body: "CA$85.00 of CA$100.00 in October." },
    { kind: "budget", key: "budget:2026-10:Dining:100", title: "Dining reached its October budget", body: "CA$115.00 of CA$100.00 in October." },
  ]);
});

test("budget heads-ups: crossing 100% at once sends only that one, and last month counts after it ends", () => {
  setBudget(db, spaceId, "Groceries", 100);
  importMoney(db, spaceId, previewMoney("Date,Description,Amount\n2026-10-28,LOBLAWS,-140\n", { signs: "negative-out" }));
  expect(checkBudgets(db, spaceId, Date.parse("2026-11-02T15:00:00Z"))).toBe(1);
  expect(nudgeRows().map((n) => n.key)).toEqual(["budget:2026-10:Groceries:100"]);
  // Two months later it's history, not a heads-up.
  db.query("DELETE FROM money_nudges").run();
  expect(checkBudgets(db, spaceId, Date.parse("2026-12-15T15:00:00Z"))).toBe(0);
});

test("budget heads-ups show for two days; nudges never carry a card number", () => {
  const at = Date.parse("2026-10-20T15:00:00Z");
  setBudget(db, spaceId, "Other", 10);
  importMoney(db, spaceId, previewMoney("Date,Description,Amount\n2026-10-02,GADGET,-50\n", { signs: "negative-out" }));
  checkBudgets(db, spaceId, at);
  expect(activeNudges(db, at + 3600_000)).toMatchObject([{ kind: "budget", spaceName: "Investing", path: `/space/${spaceId}?tab=money`, title: "Other reached its October budget" }]);
  expect(activeNudges(db, at + 3 * 86_400_000)).toEqual([]);
  for (const n of nudgeRows()) expect(isMasked(`${n.title} ${n.body}`)).toBe(true);
});

test("the monthly reminder: on the 2nd, once, naming the accounts not imported for last month", () => {
  for (const f of ["td-chequing.csv", "td-credit.csv", "amex.csv", "ws-cash.csv"]) importMoney(db, spaceId, previewMoney(csv(f)));
  // November 1st: too early.
  importReminder(db, spaceId, Date.parse("2026-11-01T15:00:00Z"));
  expect(nudgeRows()).toEqual([]);
  // October is in for every account: nothing to say.
  importReminder(db, spaceId, Date.parse("2026-11-02T15:00:00Z"));
  expect(nudgeRows()).toEqual([]);
  // December 2nd: November is missing everywhere.
  const dec2 = Date.parse("2026-12-02T15:00:00Z");
  importReminder(db, spaceId, dec2);
  importReminder(db, spaceId, dec2 + 3600_000);
  expect(nudgeRows()).toEqual([
    { kind: "import", key: "import:2026-11", title: "Time to import November", body: "Amex, TD chequing, TD credit card and Wealthsimple savings aren't imported for November yet." },
  ]);
  expect(activeNudges(db, dec2 + 5 * 86_400_000)).toHaveLength(1);
});

test("the monthly reminder clears itself once the import is in, and stays gone when dismissed", () => {
  importMoney(db, spaceId, previewMoney("Date,Description,Amount\n2026-10-01,COFFEE,-4\n2026-10-31,COFFEE,-4\n", { account: "Amex", signs: "negative-out" }));
  const dec2 = Date.parse("2026-12-02T15:00:00Z");
  importReminder(db, spaceId, dec2);
  expect(activeNudges(db, dec2).map((n) => n.body)).toEqual(["Amex isn't imported for November yet."]);
  importMoney(db, spaceId, previewMoney("Date,Description,Amount\n2026-11-02,COFFEE,-4\n2026-11-29,COFFEE,-4\n", { account: "Amex", signs: "negative-out" }));
  importReminder(db, spaceId, dec2 + 1000);
  expect(activeNudges(db, dec2 + 1000)).toEqual([]);
  db.query("DELETE FROM money_nudges").run();
  db.query("DELETE FROM money_transactions WHERE date LIKE '2026-11%'").run();
  db.query("DELETE FROM money_imports WHERE first_date LIKE '2026-11%'").run();
  importReminder(db, spaceId, dec2);
  const [n] = activeNudges(db, dec2);
  dismissNudge(db, n!.id, dec2);
  importReminder(db, spaceId, dec2 + 86_400_000);
  expect(activeNudges(db, dec2 + 86_400_000)).toEqual([]);
  expect(() => dismissNudge(db, n!.id, dec2)).toThrow("That reminder is already gone. Refresh the page.");
});

test("nothing to remind about before the first import; the daily check runs once a day", () => {
  moneyDaily(db, Date.parse("2026-12-02T15:00:00Z"));
  expect(nudgeRows()).toEqual([]);
  importMoney(db, spaceId, previewMoney("Date,Description,Amount\n2026-10-01,COFFEE,-4\n2026-10-31,COFFEE,-4\n", { account: "Amex", signs: "negative-out" }));
  moneyDaily(db, Date.parse("2026-12-02T16:00:00Z"));
  expect(nudgeRows()).toEqual([]);
  moneyDaily(db, Date.parse("2026-12-03T16:00:00Z"));
  expect(nudgeRows().map((n) => n.key)).toEqual(["import:2026-11"]);
});

test("card data: no money code talks to the network; only Claude's prompt ever carries money facts", () => {
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  const dir = join(import.meta.dir, "../../../src/engine/money");
  for (const f of readdirSync(dir)) {
    const src = readFileSync(join(dir, f), "utf8");
    expect(src).not.toMatch(/\bfetch\(|https?:\/\/|Bun\.connect|node:net|node:http|WebSocket/);
  }
  // Provider code never imports money code.
  const markets = join(import.meta.dir, "../../../src/engine/markets/providers");
  for (const f of readdirSync(markets)) expect(readFileSync(join(markets, f), "utf8")).not.toContain("money");
});

test("card data: the masker is an allow-list of dates, money amounts and short numbers", () => {
  expect(mask("X 41111 111111.11111 Y")).toBe("X ··1111 Y");
  expect(mask("X 41111.111111 11111 Y")).toBe("X ··1111 Y");
  for (const card of ["4111 1111 1111 1111", "4111-1111-1111-1111", "4111.1111.1111.1111", "4111,1111,1111,1111", "4111  1111  1111  1111", "4111 - 1111 - 1111 - 1111"]) expect(mask(`CARD ${card}`)).toBe("CARD ··1111");
  expect(mask("PAYMENT 2026-10-02 12.50")).toBe("PAYMENT 2026-10-02 12.50");
  expect(mask("Costco 1,234.56")).toBe("Costco 1,234.56");
  expect(mask("acct 1234567")).toBe("acct ··4567");
  expect(mask("Store #4410 on 10/02/2026 for 54.99")).toBe("Store #4410 on 10/02/2026 for 54.99");
});

test("card data: 1,000 random card numbers with random separators never show more than the last 4 digits", () => {
  let seed = 42;
  const rnd = (n: number) => ((seed = (seed * 16807) % 2147483647) % n);
  const seps = [" ", "-", ".", "/", ",", "", "  ", " - ", "X", "*"];
  const words = ["PAYMENT", "UBER", "REF", "TO", "CARD", "THANK YOU", "#", "ON", "2026-10-02", "12.50", "ACCT"];
  for (let i = 0; i < 1000; i++) {
    const len = 12 + rnd(8);
    const digits = Array.from({ length: len }, () => String(rnd(10))).join("");
    let card = "";
    for (let j = 0; j < len; j++) card += digits[j]! + (j < len - 1 && rnd(4) === 0 ? seps[rnd(seps.length)]! : "");
    const text = `${words[rnd(words.length)]} ${card} ${words[rnd(words.length)]}`;
    const out = mask(text);
    const visible = out.replace(/\D+/g, " ").trim().split(" ").filter((r) => digits.includes(r) && r.length > 4 && !words.join(" ").includes(r));
    expect({ text, out, visible }).toEqual({ text, out, visible: [] });
    // No run of more than 4 of the card's digits survives in order, with or without separators.
    expect(out.replace(/[^0-9]/g, "").includes(digits.slice(0, 5))).toBe(false);
  }
});

test("card data: 2,000 numbers split by newlines, Unicode spaces, punctuation or invisible characters never leak", () => {
  let seed = 20261106;
  const rnd = (n: number) => ((seed = (seed * 48271) % 2147483647) % n);
  const seps = ["\n", "\t", "\u00A0", "\u2007", "\u202F", "\u3000", "  ", "    ", "/", "|", "_", "+", "\u200B", "\u200D", "\uFEFF", " ", "-", ".", ",", "X", "**"];
  const words = ["PAYMENT", "UBER", "REF", "TO", "CARD", "THANK YOU", "ON", "2026-10-02", "12.50", "ACCT", "1,234.56"];
  for (let i = 0; i < 2000; i++) {
    const len = 12 + rnd(8);
    const digits = Array.from({ length: len }, () => String(rnd(10))).join("");
    let card = "";
    for (let j = 0; j < len; j++) card += digits[j]! + (j < len - 1 && rnd(3) === 0 ? seps[rnd(seps.length)]! + (rnd(5) === 0 ? seps[rnd(seps.length)]! : "") : "");
    const text = `${words[rnd(words.length)]} ${card} ${words[rnd(words.length)]}`;
    const out = mask(text);
    // Whatever is left of the card's digits, in order, is at most its last 4.
    const left = out.normalize("NFKC").replace(/[^0-9]/g, "");
    expect({ text, leaked: left.includes(digits.slice(0, 5)) || left.includes(digits.slice(-8, -3)) }).toEqual({ text, leaked: false });
    expect(isMasked(out)).toBe(true);
  }
});

test("card data: a number split across CSV fields that end up in one description is masked", () => {
  const p = previewMoney(["Date,Description 1,Description 2,Amount", '2026-10-02,"PAYMENT 4111 1111","1111 1111 THANKS",-5'].join("\n"));
  expect(p.rows[0]!.description).toBe("PAYMENT ··1111 THANKS");
  const nb = previewMoney("Date,Description,Amount\n2026-10-02,\"CARD 4111\u00A01111\n1111\u30001111\",-5\n");
  expect(nb.rows[0]!.description).not.toMatch(/1111.*1111/);
});

test("card data: the merchant is derived from masked text, so a cut can't leave pieces of a number", () => {
  const rows = [
    "Date,Description 1,Description 2,Amount",
    '2026-10-02,"41111 1111","1111 1111 STORE",-5',
    '2026-10-03,"4111-1111-1111-1111",,-5',
    '2026-10-04,"#41111",,-5',
  ];
  const p = previewMoney(rows.join("\n"));
  importMoney(db, spaceId, p);
  const stored = db.query("SELECT description, merchant FROM money_transactions").all() as { description: string; merchant: string }[];
  for (const r of [...stored, ...p.rows]) {
    for (const v of [r.description, r.merchant]) expect(v.replace(/\D/g, "")).not.toMatch(/\d{5}/);
  }
});

test("a million or more in the amount column is skipped as not an amount, and counted", () => {
  const p = previewMoney("Date,Description,Amount\n2026-10-02,LOBLAWS,-20\n2026-10-03,REF,-4111111111111111\n2026-10-04,BIG,1000000\n", { signs: "negative-out" });
  expect(p.rows).toHaveLength(1);
  expect(p.skipped).toEqual([
    { line: 3, reason: "That doesn't look like an amount. Check the Amount column." },
    { line: 4, reason: "That doesn't look like an amount. Check the Amount column." },
  ]);
  expect(isMasked("Spent CA$9,999,999.99")).toBe(true);
  expect(isMasked("Spent CA$12,345,678.00")).toBe(false);
  expect(isMasked("Spent CA$12345678.00")).toBe(false);
});

// ---- Re-masking rows from Plan 10 ----
import { remaskMoney } from "../../../src/engine/money/remask";

test("the one-time re-mask cleans Plan 10 rows, drops their date-hidden twins, and is safe to run again", () => {
  const ins = db.query(
    "INSERT INTO money_transactions (id, space_id, source, account, date, description, merchant, amount, currency, kind, symbol, fingerprint, imported_at) VALUES (?, ?, 'bank', ?, ?, ?, ?, ?, 'CAD', 'spend', NULL, ?, 1)",
  );
  db.query("DELETE FROM settings WHERE key = 'money.remaskedThrough'").run();
  remaskMoney(db);
  expect(db.query("SELECT value FROM settings WHERE key = 'money.remaskedThrough'").get()).toEqual({ value: "0" });
  db.query("DELETE FROM settings WHERE key = 'money.remaskedThrough'").run();
  ins.run("mtx_a", spaceId, "Visa 4111.1111.1111.1111", "2026-09-02", "PAYMENT 4111.1111.1111.1111", "Payment", -5, "fp_a");
  ins.run("mtx_b", spaceId, "Imported", "2026-10-02", "UBER TRIP ··1001", "Uber Trip", -12, "fp_b");
  ins.run("mtx_c", spaceId, "TD chequing", "2026-10-02", "UBER TRIP 2026-10-01", "Uber Trip", -12, "fp_c");
  ins.run("mtx_d", spaceId, "Imported", "2026-10-05", "COFFEE", "Coffee", -3, "fp_d");
  db.query("INSERT INTO money_imports (id, space_id, account, first_date, last_date, rows, imported_at) VALUES ('mim_a', ?, 'Visa 4111.1111.1111.1111', '2026-09-02', '2026-09-02', 1, 1)").run(spaceId);
  db.query("INSERT INTO money_nudges (id, space_id, kind, key, title, body, created_at) VALUES ('mnd_a', ?, 'import', 'k', 'Card 4111.1111.1111.1111', 'x', 1)").run(spaceId);
  db.query("INSERT INTO money_budgets (space_id, category, monthly_limit, updated_at) VALUES (?, 'Ref 4111.1111.1111.1111', 5, 1)").run(spaceId);
  remaskMoney(db);
  const rows = db.query("SELECT id, account, description, fingerprint FROM money_transactions ORDER BY id").all() as { id: string; account: string; description: string; fingerprint: string }[];
  expect(rows.map((r) => r.id)).toEqual(["mtx_a", "mtx_c", "mtx_d"]);
  expect(rows[0]).toMatchObject({ account: "Visa ··1111", description: "PAYMENT ··1111" });
  expect(rows.every((r) => !r.fingerprint.startsWith("fp_"))).toBe(true);
  expect(db.query("SELECT account FROM money_imports WHERE id = 'mim_a'").get()).toEqual({ account: "Visa ··1111" });
  expect(db.query("SELECT title FROM money_nudges").get()).toEqual({ title: "Card ··1111" });
  expect(db.query("SELECT category FROM money_budgets").get()).toEqual({ category: "Ref ··1111" });
  const before = JSON.stringify(db.query("SELECT * FROM money_transactions ORDER BY id").all());
  remaskMoney(db);
  expect(JSON.stringify(db.query("SELECT * FROM money_transactions ORDER BY id").all())).toBe(before);
  // Re-importing the old file adds nothing; its date-hidden copy is already gone.
  expect(importMoney(db, spaceId, previewMoney("Date,Description,Amount\n2026-10-05,COFFEE,-3\n", { signs: "negative-out" }))).toEqual({ added: 0, duplicates: 1 });
});

test("card data: the Luhn backstop checks a whole span, even one made of amount-looking pieces", () => {
  for (const s of ["X 4111.11 1111.11 1111.11", "REF 4111a1111b1111c1111", "4111-----1111-----1111-----1111"]) {
    const out = mask(s);
    expect(out.replace(/\D/g, "")).not.toContain("41111");
    expect(isMasked(out)).toBe(true);
  }
  // Readable here because no Luhn-valid run crosses from one date into the other.
  expect(mask("From 2026-10-01 to 2026-10-30.")).toBe("From 2026-10-01 to 2026-10-30.");
  expect(mask("4111 a 1111 b 1111 c 1111")).toBe("··1111");
  expect(mask("Groceries CA$58.14 (CA$374.40 to CA$432.54)")).toBe("Groceries CA$58.14 (CA$374.40 to CA$432.54)");
});

test("e-transfers sent to other people are spending, and the recap says how much", () => {
  importMoney(db, spaceId, previewMoney("Date,Description,Amount\n2026-10-01,E-TRANSFER SENT J SAMPLE,-1650\n2026-10-03,LOBLAWS,-80\n", { signs: "negative-out", account: "TD chequing" }));
  const r = recap(db, spaceId, NOW, "2026-10")!;
  expect(r.spent).toBe(1730);
  expect(r.eTransfers).toEqual({ count: 1, total: 1650 });
  expect(recapFacts(r).join("\n")).toContain("Spending includes CA$1,650.00 in 1 e-transfer sent to other people.");
});

test("card data: rule and budget text is masked when it's saved", () => {
  setRules(db, spaceId, [{ match: "ref 4111 1111 1111 1111", category: "Other" }]);
  expect(listRules(db, spaceId)).toEqual([{ match: "ref ··1111", category: "Other" }]);
  setBudget(db, spaceId, "Card 4111111111111111", 5);
  expect(listBudgets(db, spaceId).map((b) => b.category)).toEqual(["Card ··1111"]);
  expect(budgetRows([{ category: "Dining", limit: 100 }], [{ category: "Dining", amount: 79.9 }])[0]!.pct).toBe(79);
});

// ---- Second fix wave ----

test("readable shapes are only single dates, amounts and date ranges; phones and times beside dates are masked", () => {
  for (const s of ["PRESTO 10/01/2026 TO 10/31/2026", "PASS 2026-10-01 to 2026-10-30", "PAID 10/01/2026 - 10/30/2026", "from Aug 1, 2026 to Oct 30, 2026", "PAYMENT 2026-10-02 12.50"]) {
    expect(mask(s)).toBe(s);
  }
  // Safety over readability: these are masked.
  expect(mask("ROGERS 416-555-0199")).toBe("ROGERS ··0199");
  expect(mask("CALL (416) 555-0199")).toBe("CALL (··0199");
  expect(mask("UBER TRIP 2026-10-01 12:34")).toBe("UBER TRIP ··1234");
  // A card among dates is still caught, and so is a bare day and year.
  expect(mask("2026-10-01 4111 1111 1111 1111")).not.toContain("4111");
  expect(mask("PASS 2026-10-01 to 4111111111111111 to 2026-10-30")).not.toContain("411111");
  expect(mask("X 30, 2026")).toBe("X ··2026");
  expect(mask("Oct 31, 2026 4111111111111111")).not.toContain("411111");
});

test("card data: the database is opened with secure_delete on", () => {
  expect(db.query("PRAGMA secure_delete").get()).toEqual({ secure_delete: 1 });
});

test("card data: answers to Plan 10 money asks are re-masked: write-ups, the task, its review and its transcript", () => {
  const { remaskMoney } = require("../../../src/engine/money/remask") as typeof import("../../../src/engine/money/remask");
  const { createTask } = require("../../../src/engine/tasks") as typeof import("../../../src/engine/tasks");
  const { saveWriteup } = require("../../../src/engine/markets/research") as typeof import("../../../src/engine/markets/research");
  const { createApproval } = require("../../../src/engine/approvals") as typeof import("../../../src/engine/approvals");
  const { writeFileSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
  const card = "4111.1111.1111.1111";
  const t = createTask(db, { spaceId, title: "Ask Claude about my money", detail: `Is ${card} mine?`, agent: "claude", weight: "light", purpose: "money" });
  saveWriteup(db, { spaceId, kind: "money", key: null, forDate: "2026-10-02T00:00:00.000Z", body: `Card ${card}.`, taskId: t.id });
  createApproval(db, { spaceId, taskId: t.id, kind: "review", title: "x", detail: `Said ${card}` });
  const dir = join(home.home, "transcripts");
  mkdirSync(dir, { recursive: true });
  const log = join(dir, "run_old.log");
  writeFileSync(log, `Card 4111\n1111 1111\n1111\n`);
  db.query("INSERT INTO runs (id, task_id, agent, started_at, transcript_path) VALUES ('run_old', ?, 'claude', 1, ?)").run(t.id, log);
  db.query("DELETE FROM settings WHERE key = 'money.remaskedThrough'").run();
  expect(remaskMoney(db)).toBe(true);
  expect((db.query("SELECT body FROM market_writeups WHERE kind = 'money'").get() as { body: string }).body).toBe("Card ··1111.");
  expect((db.query("SELECT detail FROM tasks WHERE id = ?").get(t.id) as { detail: string }).detail).toBe("Is ··1111 mine?");
  expect((db.query("SELECT detail FROM approvals WHERE task_id = ?").get(t.id) as { detail: string }).detail).toBe("Said ··1111");
  expect(readFileSync(log, "utf8")).not.toMatch(/1111\s+1111/);
  // Nothing new to check the second time.
  expect(remaskMoney(db)).toBe(false);
});

test("card data: a database that ran only the first re-mask runs the full v2 pass, then checkpoints and vacuums", () => {
  const { remaskMoney } = require("../../../src/engine/money/remask") as typeof import("../../../src/engine/money/remask");
  const { createTask } = require("../../../src/engine/tasks") as typeof import("../../../src/engine/tasks");
  const { saveWriteup } = require("../../../src/engine/markets/research") as typeof import("../../../src/engine/markets/research");
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  // As a v1 engine left it: the row marker set, no v2 key, and an old answer with a raw number.
  db.query("DELETE FROM settings WHERE key = 'money.remask.v2'").run();
  db.query("INSERT INTO settings (key, value) VALUES ('money.remaskedThrough', '0') ON CONFLICT(key) DO UPDATE SET value = '0'").run();
  const t = createTask(db, { spaceId, title: "Ask Claude about my money", detail: "Where?", agent: "claude", weight: "light", purpose: "money" });
  saveWriteup(db, { spaceId, kind: "money", key: null, forDate: "2026-10-02T00:00:00.000Z", body: "Card 4111.1111.1111.1111.", taskId: t.id });
  db.close();
  db = openDb();
  expect((db.query("SELECT body FROM market_writeups").get() as { body: string }).body).toBe("Card ··1111.");
  expect(db.query("SELECT value FROM settings WHERE key = 'money.remask.v2'").get()).toEqual({ value: "1" });
  db.close();
  const raw = readdirSync(home.home).filter((f) => f.includes(".db")).map((f) => readFileSync(join(home.home, f)).toString("latin1")).join("");
  expect(raw).not.toContain("4111.1111.1111");
  db = openDb();
  expect(remaskMoney(db)).toBe(false);
});
