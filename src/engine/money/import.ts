import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { bus } from "../events";
import { newId } from "../ids";
import { parseCsv } from "../markets/csv";
import { merchantOf } from "./categories";

// Bank and card exports (RBC, TD, Scotiabank and the like) and Wealthsimple activity exports, read on this Mac.
// Columns are found by name, a headerless TD-style file by shape, and anything else is mapped by hand in the preview.
export type MoneyField = "date" | "description" | "description2" | "amount" | "debit" | "credit" | "account" | "accountNumber" | "type";
export type MoneyMap = Partial<Record<MoneyField, number>>;
export type Signs = "negative-out" | "positive-out";
export type DateOrder = "mdy" | "dmy";
export type MoneyKind = "spend" | "income" | "deposit" | "withdrawal" | "dividend" | "fee" | "buy" | "sell" | "interest" | "other";
export type MoneyRow = {
  source: "bank" | "wealthsimple";
  account: string;
  date: string;
  description: string;
  merchant: string;
  amount: number;
  currency: "CAD" | "USD";
  kind: MoneyKind;
  symbol: string | null;
};
export type MoneyPreview = {
  format: "bank" | "wealthsimple" | "unknown";
  headers: string[];
  mapping: MoneyMap;
  signs: Signs;
  dates: DateOrder;
  rows: MoneyRow[];
  skipped: { line: number; reason: string }[];
  warnings: string[];
  guessed: string[];
  accounts: string[];
};

export const MAX_ROWS = 20_000;
const MAX_DESCRIPTION = 200;

const ALIASES: Record<MoneyField, string[]> = {
  date: ["transaction date", "date", "posted date", "posting date", "trans date"],
  description: ["description 1", "description", "merchant", "payee", "transaction description", "details", "name"],
  description2: ["description 2", "sub-description", "memo"],
  amount: ["cad$", "amount", "amount (cad)", "transaction amount"],
  debit: ["debit", "withdrawals", "withdrawal", "money out", "debit amount"],
  credit: ["credit", "deposits", "deposit", "money in", "credit amount"],
  account: ["account type", "account", "account name", "card"],
  accountNumber: ["account number", "card number"],
  type: ["type of transaction", "transaction type", "type"],
};

function detect(headers: string[]): MoneyMap {
  const lower = headers.map((h) => h.trim().toLowerCase());
  const map: MoneyMap = {};
  for (const [field, aliases] of Object.entries(ALIASES) as [MoneyField, string[]][]) {
    for (const a of aliases) {
      const i = lower.indexOf(a);
      if (i >= 0 && !Object.values(map).includes(i)) {
        map[field] = i;
        break;
      }
    }
  }
  return map;
}

// "$1,234.50" → 1234.5, "(20)" → −20, "" → NaN.
function num(raw: string | undefined): number {
  let t = (raw ?? "").replace(/[,\s]/g, "").replace(/(CA|US)\$/i, "").replace(/\$/g, "");
  let sign = 1;
  if (/^\(.*\)$/.test(t)) {
    sign = -1;
    t = t.slice(1, -1);
  }
  return t === "" ? NaN : sign * Number(t);
}

function isoDate(raw: string, order: DateOrder): string | null {
  const t = raw.trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return valid(+m[1]!, +m[2]!, +m[3]!);
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return order === "mdy" ? valid(+m[3]!, +m[1]!, +m[2]!) : valid(+m[3]!, +m[2]!, +m[1]!);
  const parsed = Date.parse(t);
  return Number.isNaN(parsed) || !/[a-z]/i.test(t) ? null : new Date(parsed).toISOString().slice(0, 10);
}
// Round-tripped through a real date, so February 31 is refused rather than stored.
function valid(y: number, mo: number, d: number): string | null {
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return t.toISOString().slice(0, 10);
}

// A real date written with separators ("2026-10-02", "10/02/2026"), which masking leaves alone. Only years from 1990
// to next year count, so a card number sliced like a date ("4510.12.31") is still a number.
const DATE_RUN = /(?<![\d/.-])(?:(\d{4})([-/.])(\d{1,2})\2(\d{1,2})|(\d{1,2})([-/.])(\d{1,2})\6(\d{4}))(?![\d/.-])/g;
const NUMBER_RUN = /\d[\dX*\s./-]{4,}\d/gi;
const realDate = (y: number, a: number, b: number) => y >= 1990 && y <= new Date().getUTCFullYear() + 1 && valid(y, a, b) !== null;
const maskRuns = (s: string) =>
  s.replace(NUMBER_RUN, (run) => {
    const digits = run.replace(/\D/g, "");
    return digits.length >= 6 ? `··${digits.slice(-4)}` : run;
  });
const longRun = (s: string) => (s.match(NUMBER_RUN) ?? []).some((run) => run.replace(/\D/g, "").length >= 6);

// Card and account numbers keep their last four digits only ("4510 1234 5678 9012" → "··9012"), wherever they
// appear: a run of six or more digits, with spaces, dashes, dots, slashes or masking X and * between them. A run
// written as a real date isn't one. A bare 8-digit run is still masked, since part of an account number is worse to
// leak than a date. Dates are kept by position, never by placeholder, and if any long run survives next to a kept
// date the whole text is masked without keeping dates.
export function maskNumbers(s: string): string {
  const kept: { start: number; end: number }[] = [];
  for (const m of s.matchAll(DATE_RUN)) {
    const [, y1, , m1, d1, a2, , b2, y2] = m;
    const isDate = y1 ? realDate(+y1, +m1!, +d1!) : realDate(+y2!, +a2!, +b2!) || realDate(+y2!, +b2!, +a2!);
    if (isDate) kept.push({ start: m.index!, end: m.index! + m[0].length });
  }
  if (!kept.length) return maskRuns(s);
  const gaps: string[] = [];
  let at = 0;
  for (const k of kept) {
    gaps.push(maskRuns(s.slice(at, k.start)));
    at = k.end;
  }
  gaps.push(maskRuns(s.slice(at)));
  // Gaps checked together, so digits on both sides of a kept date can't add up to a number that slipped through.
  if (longRun(gaps.join(" "))) return maskRuns(s.replace(DATE_RUN, (d) => d.replace(/[/.-]/g, "")));
  return gaps.reduce((out, g, i) => out + g + (i < kept.length ? s.slice(kept[i]!.start, kept[i]!.end) : ""), "");
}

// A cell starting (after any spaces) with =, +, -, @ or a control character could run as a formula if the text were ever opened in a
// spreadsheet; Atrium keeps it as text without the trigger.
const safeText = (s: string) =>
  s
    .trim()
    .replace(/^[=+\-@\t\r]+/, "")
    .trim()
    .slice(0, MAX_DESCRIPTION);

const WS_KINDS: Record<string, MoneyKind> = { deposit: "deposit", withdrawal: "withdrawal", dividend: "dividend", fee: "fee", buy: "buy", sell: "sell", interest: "interest" };

function wealthsimple(headers: string[], body: string[][]): Pick<MoneyPreview, "rows" | "skipped" | "accounts"> {
  const col = (name: string) => headers.findIndex((h) => h.trim().toLowerCase() === name);
  const [date, accountType, type, sub, symbol, name, currency, cash] = ["transaction_date", "account_type", "activity_type", "activity_sub_type", "symbol", "name", "currency", "net_cash_amount"].map(col);
  const rows: MoneyRow[] = [];
  const skipped: MoneyPreview["skipped"] = [];
  body.forEach((r, n) => {
    const d = isoDate(r[date!] ?? "", "mdy");
    const amount = num(r[cash!]);
    if (!d) return skipped.push({ line: n + 2, reason: "No date Atrium can read." });
    if (Number.isNaN(amount)) return skipped.push({ line: n + 2, reason: "No amount Atrium can read." });
    const t = (r[type!] ?? "").trim().toLowerCase();
    const s = (r[sub!] ?? "").trim().toLowerCase();
    const kind = WS_KINDS[t === "trade" || t === "moneymovement" ? s : t] ?? "other";
    const label = [r[symbol!], r[name!]].filter(Boolean).join(" · ") || (r[type!] ?? "").trim();
    rows.push({
      source: "wealthsimple",
      account: (r[accountType!] ?? "").trim() || "Wealthsimple",
      date: d,
      description: safeText(`${kind[0]!.toUpperCase()}${kind.slice(1)} ${label}`.trim()),
      merchant: safeText(label) || "Wealthsimple",
      amount,
      currency: (r[currency!] ?? "").trim().toUpperCase() === "USD" ? "USD" : "CAD",
      kind,
      symbol: (r[symbol!] ?? "").trim() || null,
    });
  });
  return { rows, skipped, accounts: [...new Set(rows.map((r) => r.account))] };
}

export function previewMoney(text: string, opts: { mapping?: MoneyMap; signs?: Signs; dates?: DateOrder } = {}): MoneyPreview {
  const all = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ""));
  const warnings: string[] = [];
  const guessed: string[] = [];
  const dates: DateOrder = opts.dates ?? "mdy";
  const empty: MoneyPreview = { format: "unknown", headers: [], mapping: {}, signs: "negative-out", dates, rows: [], skipped: [], warnings, guessed, accounts: [] };
  if (!all.length) return { ...empty, warnings: ["That file is empty."] };

  let headers = all[0]!;
  let body = all.slice(1);
  if (body.length > MAX_ROWS) {
    warnings.push(`That file has more than ${MAX_ROWS.toLocaleString("en-US")} rows; Atrium imported the first ${MAX_ROWS.toLocaleString("en-US")}.`);
    body = body.slice(0, MAX_ROWS);
  }
  if (headers.some((h) => h.trim().toLowerCase() === "activity_type")) {
    return { ...empty, format: "wealthsimple", headers, ...wealthsimple(headers, body), warnings };
  }

  let mapping: MoneyMap = opts.mapping ?? detect(headers);
  // A TD export has no header row: date, description, money out, money in, balance.
  if (!opts.mapping && isoDate(headers[0] ?? "", dates) && headers.length >= 4) {
    body = all.slice(0, MAX_ROWS);
    headers = headers.map((_, i) => `Column ${i + 1}`);
    mapping = { date: 0, description: 1, debit: 2, credit: 3 };
    guessed.push("This file has no header row, so Atrium read it as date, description, money out, money in.");
  }
  const has = (f: MoneyField) => mapping[f] !== undefined;
  if (!has("date") || !has("description") || !(has("amount") || has("debit") || has("credit"))) {
    return { ...empty, headers, mapping, warnings: [...warnings, "Atrium couldn't find date, description and amount columns. Pick them below."] };
  }

  const cell = (r: string[], f: MoneyField) => (has(f) ? (r[mapping[f]!] ?? "").trim() : "");
  // With one signed amount column, card exports often write charges as positive numbers.
  const amounts = has("amount") && !has("type") ? body.map((r) => num(cell(r, "amount"))).filter((n) => !Number.isNaN(n) && n !== 0) : [];
  const mostlyPositive = amounts.length > 0 && amounts.filter((n) => n > 0).length / amounts.length >= 0.6;
  const signs: Signs = opts.signs ?? (mostlyPositive ? "positive-out" : "negative-out");
  if (!opts.signs && mostlyPositive) warnings.push("Most amounts are positive, so Atrium read them as money spent. Switch it if that's wrong.");

  const rows: MoneyRow[] = [];
  const skipped: MoneyPreview["skipped"] = [];
  const firstLine = guessed.length ? 1 : 2;
  body.forEach((r, n) => {
    const line = n + firstLine;
    const date = isoDate(cell(r, "date"), dates);
    if (!date) return skipped.push({ line, reason: "No date Atrium can read." });
    let amount: number;
    if (has("amount")) {
      amount = num(cell(r, "amount"));
      if (has("type")) {
        const out = /debit|purchase|withdraw|charge/i.test(cell(r, "type"));
        amount = out ? -Math.abs(amount) : Math.abs(amount);
      } else if (signs === "positive-out") amount = -amount;
    } else {
      const debit = num(cell(r, "debit"));
      const credit = num(cell(r, "credit"));
      amount = !Number.isNaN(credit) && credit !== 0 ? Math.abs(credit) : -Math.abs(debit);
    }
    if (Number.isNaN(amount)) return skipped.push({ line, reason: "No amount Atrium can read." });
    const d1 = maskNumbers(safeText(cell(r, "description")));
    const d2 = maskNumbers(safeText(cell(r, "description2")));
    const account = [cell(r, "account"), cell(r, "accountNumber")].filter(Boolean).join(" ") || "Imported";
    rows.push({
      source: "bank",
      account: maskNumbers(safeText(account)),
      date,
      description: [d1, d2].filter(Boolean).join(" "),
      merchant: merchantOf(d1 || d2),
      amount: Math.round(amount * 100) / 100,
      currency: "CAD",
      kind: amount < 0 ? "spend" : "income",
      symbol: null,
    });
  });
  if (!rows.length && !warnings.length) warnings.push("Nothing in that file could be read. Check the columns below.");
  return { format: "bank", headers, mapping, signs, dates, rows, skipped, warnings, guessed, accounts: [...new Set(rows.map((r) => r.account))] };
}

// Re-importing the same file adds nothing: each row's fingerprint is its account, date, amount and description,
// plus how many identical rows came before it in the file, so two real identical charges both stay.
export function importMoney(db: Database, spaceId: string, p: MoneyPreview): { added: number; duplicates: number } {
  const seen = new Map<string, number>();
  const put = db.query(
    `INSERT OR IGNORE INTO money_transactions (id, space_id, source, account, date, description, merchant, amount, currency, kind, symbol, fingerprint, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let added = 0;
  const at = Date.now();
  db.transaction(() => {
    for (const r of p.rows) {
      const base = [r.source, r.account, r.date, r.amount.toFixed(2), r.currency, r.description.toLowerCase()].join("|");
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      const fingerprint = createHash("sha256").update(`${base}|${n}`).digest("hex").slice(0, 32);
      added += put.run(newId("mtx"), spaceId, r.source, r.account, r.date, r.description, r.merchant, r.amount, r.currency, r.kind, r.symbol, fingerprint, at).changes;
    }
  })();
  if (added) bus.emit({ type: "changed" });
  return { added, duplicates: p.rows.length - added };
}
