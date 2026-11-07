import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { bus } from "../events";
import { newId } from "../ids";
import { parseCsv } from "../markets/csv";
import { ACCOUNTS, detectBank, OTHER_ACCOUNT, WS_INTEREST_CODES, WS_TRANSFER_CODES, type Bank } from "./banks";
import { merchantOf } from "./categories";
import { monthEnd } from "./coverage";

// Bank and card exports (TD, Amex, Wealthsimple Cash, RBC, Scotiabank and the like) and Wealthsimple activity exports,
// read on this Mac. Known banks are found by shape (banks.ts), other columns by name, and anything else is mapped by
// hand in the preview.
export type MoneyField = "date" | "description" | "description2" | "amount" | "debit" | "credit" | "account" | "accountNumber" | "type";
export type MoneyMap = Partial<Record<MoneyField, number>>;
export type Signs = "negative-out" | "positive-out";
export type DateOrder = "mdy" | "dmy";
export type MoneyKind = "spend" | "income" | "deposit" | "withdrawal" | "dividend" | "fee" | "buy" | "sell" | "interest" | "transfer" | "other";
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
  bank: Bank;
  // The account every row was put in, for a file that doesn't name its own; null when the file does.
  account: string | null;
};
export type PreviewOptions = { mapping?: MoneyMap; signs?: Signs; dates?: DateOrder; account?: string };

export const MAX_ROWS = 20_000;
// A million or more is a card or reference number in the wrong column, not one transaction: the row is skipped, so
// the number is never stored.
const MAX_AMOUNT = 1_000_000;
const TOO_LARGE = "That doesn't look like an amount. Check the Amount column.";
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
  // Amex writes "05 Nov 2026" or "05 Nov. 2026"; some exports write "Nov 05, 2026". Read by hand, not by Date.parse,
  // so the time zone can't move a date.
  m = t.match(/^(\d{1,2})\s+([a-z]{3})[a-z]*\.?,?\s+(\d{4})$/i);
  if (m) return monthName(m[2]!) ? valid(+m[3]!, monthName(m[2]!)!, +m[1]!) : null;
  m = t.match(/^([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/i);
  if (m) return monthName(m[1]!) ? valid(+m[3]!, monthName(m[1]!)!, +m[2]!) : null;
  return null;
}
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const monthName = (s: string): number | null => {
  const i = MONTHS.indexOf(s.slice(0, 3).toLowerCase());
  return i < 0 ? null : i + 1;
};
// Round-tripped through a real date, so February 31 is refused rather than stored.
function valid(y: number, mo: number, d: number): string | null {
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return t.toISOString().slice(0, 10);
}

// The masker is an allow-list. Text is first normalised: invisible format characters removed, every decimal digit
// from any script turned into 0–9, then NFKC. A digit cluster is digits whose gaps are at most 4 characters with no
// letter in them (masking X and * aside, a run of whitespace counting as one), so spaces, newlines, punctuation or
// Unicode spaces still join a split number. A cluster with 6 or more digits is masked to its last 4 unless it is one
// real date, one money amount under CA$10,000,000, or real dates with at most one amount beside them. Last, a Luhn
// check catches a card number whose pieces were split by letters or long gaps.
const MAX_GAP = 4;
const MASK_CHAR = /[Xx*]/;
const LETTER = /\p{L}/u;
const DATE = /^(?:(\d{4})([-/.])(\d{1,2})\2(\d{1,2})|(\d{1,2})([-/.])(\d{1,2})\6(\d{4}))$/;
// At most 7 digits before the point, so a card number can never pass as a money amount.
const AMOUNT = /^(?:\d{1,3}(?:,\d{3})?\.\d{2}|\d,\d{3},\d{3}\.\d{2}|\d{1,7}\.\d{2})$/;
// An account, transit or reference number next to the word that names it: 5 digits are enough there.
const NAMED_RUN = /(?<![\p{L}\d])(acct|account|transit|no\.?|#)(\s*[:.]?\s*)(\d[\d\s-]{3,}\d)/giu;
const realDate = (y: number, a: number, b: number) => y >= 1990 && y <= new Date().getUTCFullYear() + 1 && valid(y, a, b) !== null;
const last4 = (run: string) => `··${run.replace(/\D/g, "").slice(-4)}`;
const LUHN_MIN = 13;
const LUHN_MAX = 19;
const LOOSE_GAP = 8;
const LOOSE_LETTERS = 2;

function isDate(part: string): boolean {
  const m = part.match(DATE);
  if (!m) return false;
  const [, y1, , m1, d1, a2, , b2, y2] = m;
  return y1 ? realDate(+y1, +m1!, +d1!) : realDate(+y2!, +a2!, +b2!) || realDate(+y2!, +b2!, +a2!);
}

const partsOf = (cluster: string) =>
  cluster
    .split(/[^\d.,/-]+/)
    .map((p) => p.replace(/^[.,/-]+|[.,/-]+$/g, ""))
    .filter(Boolean);

function safeCluster(cluster: string): boolean {
  if (cluster.replace(/\D/g, "").length < 6) return true;
  const parts = partsOf(cluster);
  const amounts = parts.filter((p) => AMOUNT.test(p)).length;
  return parts.every((p) => isDate(p) || AMOUNT.test(p)) && (parts.length === 1 || amounts <= 1);
}

// A gap joins two digits unless it's too long, holds a letter, or holds Atrium's own "··" mask mark (so masked
// output reads as masked when checked again). Any run of whitespace counts as one character.
function joins(gap: string): boolean {
  if (gap.includes("··")) return false;
  let length = 0;
  let space = false;
  for (const ch of gap) {
    if (MASK_CHAR.test(ch)) continue;
    if (LETTER.test(ch)) return false;
    const isSpace = /\s/u.test(ch);
    if (!isSpace || !space) length++;
    space = isSpace;
  }
  return length <= MAX_GAP;
}

// The backstop's looser join: up to 8 characters with at most 2 letters in them.
const looseJoins = (gap: string) => !gap.includes("··") && gap.length <= LOOSE_GAP && [...gap].filter((c) => LETTER.test(c)).length <= LOOSE_LETTERS;

function luhn(d: string): boolean {
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = +d[d.length - 1 - i]!;
    if (i % 2) n = n * 2 > 9 ? n * 2 - 9 : n * 2;
    sum += n;
  }
  return sum % 10 === 0;
}

// Digits joined by a loose gap that hold a Luhn-valid 13–19 digit run are a card number, unless every piece of them
// is a date or an amount.
function luhnBackstop(s: string): string {
  const at = [...s.matchAll(/\d/g)].map((m) => m.index!);
  let out = "";
  let from = 0;
  for (let i = 0; i < at.length; ) {
    let j = i;
    while (j + 1 < at.length && looseJoins(s.slice(at[j]! + 1, at[j + 1]!))) j++;
    const span = s.slice(at[i]!, at[j]! + 1);
    const digits = span.replace(/\D/g, "");
    const harmless = partsOf(span).every((p) => isDate(p) || AMOUNT.test(p));
    let card = false;
    for (let len = LUHN_MIN; !harmless && !card && len <= Math.min(LUHN_MAX, digits.length); len++) {
      for (let k = 0; k + len <= digits.length && !card; k++) card = luhn(digits.slice(k, k + len));
    }
    out += s.slice(from, at[i]!) + (card ? last4(span) : span);
    from = at[j]! + 1;
    i = j + 1;
  }
  return out + s.slice(from);
}

// Every Unicode decimal digit (Arabic-Indic, Devanagari, …) as its ASCII value: each script's digits run 0 to 9 in
// blocks of ten.
function asciiDigits(s: string): string {
  return s.replace(/\p{Nd}/gu, (ch) => {
    const cp = ch.codePointAt(0)!;
    let zero = cp;
    // Walk to the start of the run: some scripts put several blocks of ten side by side.
    while (/\p{Nd}/u.test(String.fromCodePoint(zero - 1))) zero--;
    return String((cp - zero) % 10);
  });
}

// Card and account numbers keep their last four digits only ("4111 1111 1111 1111" → "··1111"), wherever they appear.
export function maskNumbers(input: string): string {
  const s = asciiDigits(input.replace(/\p{Cf}/gu, ""))
    .normalize("NFKC")
    .replace(NAMED_RUN, (all, word: string, gap: string, run: string) => (run.replace(/\D/g, "").length >= 5 ? `${word}${gap}${last4(run)}` : all));
  const digits = [...s.matchAll(/\d/g)].map((m) => m.index!);
  let out = "";
  let at = 0;
  for (let i = 0; i < digits.length; ) {
    let j = i;
    while (j + 1 < digits.length && joins(s.slice(digits[j]! + 1, digits[j + 1]!))) j++;
    const start = digits[i]!;
    const end = digits[j]! + 1;
    const cluster = s.slice(start, end);
    out += s.slice(at, start) + (safeCluster(cluster) ? cluster : last4(cluster));
    at = end;
    i = j + 1;
  }
  return luhnBackstop(out + s.slice(at));
}

// True when text has no card or account number left in it: masking would change nothing.
export const isMasked = (s: string): boolean => maskNumbers(s) === s;

// A Wealthsimple Cash transaction code ("AFT_IN"), the only raw cell kept as text when a row has no description.
const TYPE_CODE = /^[A-Z_ ]{1,20}$/;
const MAX_ACCOUNT = 40;

// An account name Nakul picked or typed: one of his known accounts as is, anything else cleaned and masked.
function cleanAccount(raw: string | undefined): string | null {
  const t = (raw ?? "").trim();
  if (!t) return null;
  if ((ACCOUNTS as readonly string[]).includes(t) || t === OTHER_ACCOUNT) return t;
  return maskNumbers(safeText(t)).slice(0, MAX_ACCOUNT) || null;
}

// The one way a row reaches the database: every text field masked again, however it was built, so no full card or
// account number is ever written, fingerprints included.
export function storeRow(r: MoneyRow): MoneyRow {
  const clean = (s: string) => maskNumbers(safeText(s));
  return {
    ...r,
    account: clean(r.account).slice(0, MAX_ACCOUNT) || OTHER_ACCOUNT,
    description: clean(r.description),
    merchant: clean(r.merchant),
    symbol: r.symbol === null ? null : clean(r.symbol).slice(0, 20) || null,
  };
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
    if (Math.abs(amount) >= MAX_AMOUNT) return skipped.push({ line: n + 2, reason: TOO_LARGE });
    const t = (r[type!] ?? "").trim().toLowerCase();
    const s = (r[sub!] ?? "").trim().toLowerCase();
    const kind = WS_KINDS[t === "trade" || t === "moneymovement" ? s : t] ?? "other";
    // Masked first; the description and merchant are built from the masked label.
    const label = maskNumbers(safeText([r[symbol!], r[name!]].filter(Boolean).join(" · ") || (r[type!] ?? "").trim()));
    rows.push({
      source: "wealthsimple",
      account: maskNumbers(safeText(r[accountType!] ?? "")) || "Wealthsimple",
      date: d,
      description: `${kind[0]!.toUpperCase()}${kind.slice(1)} ${label}`.trim(),
      merchant: label || "Wealthsimple",
      amount,
      currency: (r[currency!] ?? "").trim().toUpperCase() === "USD" ? "USD" : "CAD",
      kind,
      symbol: maskNumbers(safeText(r[symbol!] ?? "")).slice(0, 20) || null,
    });
  });
  return { rows, skipped, accounts: [...new Set(rows.map((r) => r.account))] };
}

// A Wealthsimple Cash monthly statement: date, transaction code, description, signed amount, balance.
function wsCash(headers: string[], body: string[][], account: string): Pick<MoneyPreview, "rows" | "skipped" | "accounts"> {
  const col = (name: string) => headers.findIndex((h) => h.trim().toLowerCase() === name);
  const [date, code, description, amountCol] = ["date", "transaction", "description", "amount"].map(col);
  const rows: MoneyRow[] = [];
  const skipped: MoneyPreview["skipped"] = [];
  body.forEach((r, n) => {
    const d = isoDate(r[date!] ?? "", "mdy");
    const amount = num(r[amountCol!]);
    if (!d) return skipped.push({ line: n + 2, reason: "No date Atrium can read." });
    if (Number.isNaN(amount)) return skipped.push({ line: n + 2, reason: "No amount Atrium can read." });
    if (Math.abs(amount) >= MAX_AMOUNT) return skipped.push({ line: n + 2, reason: TOO_LARGE });
    const c = (r[code!] ?? "").trim();
    const text = maskNumbers(safeText(r[description!] ?? "")) || (TYPE_CODE.test(c) ? c : maskNumbers(safeText(c)));
    const kind: MoneyKind = WS_TRANSFER_CODES.test(c) ? "transfer" : WS_INTEREST_CODES.test(c) ? "interest" : amount < 0 ? "spend" : "income";
    rows.push({ source: "bank", account, date: d, description: text, merchant: merchantOf(text), amount: Math.round(amount * 100) / 100, currency: "CAD", kind, symbol: null });
  });
  return { rows, skipped, accounts: rows.length ? [account] : [] };
}

export function previewMoney(text: string, opts: PreviewOptions = {}): MoneyPreview {
  const all = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ""));
  const warnings: string[] = [];
  const guessed: string[] = [];
  const dates: DateOrder = opts.dates ?? "mdy";
  const generic: Bank = { id: "generic", label: "Bank or card export", confidence: "low", account: null };
  const empty: MoneyPreview = { format: "unknown", headers: [], mapping: {}, signs: "negative-out", dates, rows: [], skipped: [], warnings, guessed, accounts: [], bank: generic, account: null };
  if (!all.length) return { ...empty, warnings: ["That file is empty."] };

  // Headers go back to the dashboard in the preview, so a headerless file's first row is masked like any row.
  let headers = all[0]!.map((h) => maskNumbers(h));
  let body = all.slice(1);
  if (body.length > MAX_ROWS) {
    warnings.push(`That file has more than ${MAX_ROWS.toLocaleString("en-US")} rows; Atrium imported the first ${MAX_ROWS.toLocaleString("en-US")}.`);
    body = body.slice(0, MAX_ROWS);
  }
  // With one signed amount column, card exports often write charges as positive numbers.
  const positives = (amounts: number[]) => amounts.length > 0 && amounts.filter((n) => n > 0).length / amounts.length >= 0.6;
  const bank = detectBank(all, () => positives(body.map((r) => num(r[headers.findIndex((h) => h.trim().toLowerCase() === "amount")])).filter((n) => !Number.isNaN(n) && n !== 0)));
  const account = (fallback: string | null) => cleanAccount(opts.account) || fallback;
  if (bank.id === "ws-activity") return { ...empty, format: "wealthsimple", headers, ...wealthsimple(headers, body), warnings, bank };
  if (bank.id === "ws-cash") {
    const named = account(bank.account)!;
    return { ...empty, format: "bank", headers, ...wsCash(headers, body, named), warnings, bank, account: named };
  }

  let mapping: MoneyMap = opts.mapping ?? detect(headers);
  // A TD export has no header row: date, description, money out, money in, balance.
  if (!opts.mapping && isoDate(headers[0] ?? "", dates) && headers.length >= 4) {
    body = all.slice(0, MAX_ROWS);
    headers = headers.map((_, i) => `Column ${i + 1}`);
    mapping = { date: 0, description: 1, debit: 2, credit: 3 };
    guessed.push(
      bank.id === "td"
        ? "TD files have no header row, so Atrium read it as date, description, money out, money in, balance."
        : "This file has no header row, so Atrium read it as date, description, money out, money in.",
    );
  }
  const has = (f: MoneyField) => mapping[f] !== undefined;
  if (!has("date") || !has("description") || !(has("amount") || has("debit") || has("credit"))) {
    return { ...empty, headers, mapping, warnings: [...warnings, "Atrium couldn't find date, description and amount columns. Pick them below."] };
  }

  const cell = (r: string[], f: MoneyField) => (has(f) ? (r[mapping[f]!] ?? "").trim() : "");
  const amounts = has("amount") && !has("type") ? body.map((r) => num(cell(r, "amount"))).filter((n) => !Number.isNaN(n) && n !== 0) : [];
  const mostlyPositive = positives(amounts);
  // Amex always writes charges as positive numbers, so a file it clearly made isn't guessed at.
  const amexSure = bank.id === "amex" && bank.confidence === "high";
  const signs: Signs = opts.signs ?? (amexSure || mostlyPositive ? "positive-out" : "negative-out");
  if (!opts.signs && !amexSure && mostlyPositive) warnings.push("Most amounts are positive, so Atrium read them as money spent. Switch it if that's wrong.");
  // A file with no account column goes into the account Nakul picked, or the one its bank suggests.
  const fileAccount = has("account") || has("accountNumber") ? null : account(bank.account ?? OTHER_ACCOUNT);

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
    if (Math.abs(amount) >= MAX_AMOUNT) return skipped.push({ line, reason: TOO_LARGE });
    // Masked first, before anything is derived: the description after joining, so a number split across the two
    // columns is caught whole, and the merchant from its own masked column.
    const raw1 = safeText(cell(r, "description"));
    const raw2 = safeText(cell(r, "description2"));
    const description = maskNumbers([raw1, raw2].filter(Boolean).join(" "));
    const lead = maskNumbers(raw1 || raw2);
    const named = [cell(r, "account"), cell(r, "accountNumber")].filter(Boolean).join(" ") || OTHER_ACCOUNT;
    rows.push({
      source: "bank",
      account: fileAccount ?? maskNumbers(safeText(named)),
      date,
      description,
      merchant: merchantOf(lead),
      amount: Math.round(amount * 100) / 100,
      currency: "CAD",
      kind: amount < 0 ? "spend" : "income",
      symbol: null,
    });
  });
  if (!rows.length && !warnings.length) warnings.push("Nothing in that file could be read. Check the columns below.");
  return { format: "bank", headers, mapping, signs, dates, rows, skipped, warnings, guessed, accounts: [...new Set(rows.map((r) => r.account))], bank, account: fileAccount };
}

// Re-importing the same file adds nothing: each row's fingerprint is its account, date, amount and description,
// plus how many identical rows came before it in the file, so two real identical charges both stay. Rows stored
// before Atrium named the account ("Imported") count as already here too.
export function importMoney(db: Database, spaceId: string, p: MoneyPreview): { added: number; duplicates: number } {
  const seen = new Map<string, number>();
  const put = db.query(
    `INSERT OR IGNORE INTO money_transactions (id, space_id, source, account, date, description, merchant, amount, currency, kind, symbol, fingerprint, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const legacy = db.query(
    `SELECT COUNT(*) AS n FROM money_transactions WHERE space_id = ? AND source = ? AND account = ? AND date = ? AND ROUND(amount, 2) = ? AND lower(description) = ?`,
  );
  const covered = new Map<string, { first: string; last: string; rows: number }>();
  let added = 0;
  const at = Date.now();
  db.transaction(() => {
    for (const raw of p.rows) {
      const r = storeRow(raw);
      const base = [r.source, r.account, r.date, r.amount.toFixed(2), r.currency, r.description.toLowerCase()].join("|");
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      const c = covered.get(r.account) ?? { first: r.date, last: r.date, rows: 0 };
      covered.set(r.account, { first: r.date < c.first ? r.date : c.first, last: r.date > c.last ? r.date : c.last, rows: c.rows + 1 });
      if (r.account !== OTHER_ACCOUNT && (legacy.get(spaceId, r.source, OTHER_ACCOUNT, r.date, r.amount, r.description.toLowerCase()) as { n: number }).n >= n) continue;
      const fingerprint = createHash("sha256").update(`${base}|${n}`).digest("hex").slice(0, 32);
      added += put.run(newId("mtx"), spaceId, r.source, r.account, r.date, r.description, r.merchant, r.amount, r.currency, r.kind, r.symbol, fingerprint, at).changes;
    }
    const log = db.query("INSERT INTO money_imports (id, space_id, account, first_date, last_date, rows, imported_at, period_start, period_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    // A Wealthsimple Cash statement covers whole calendar months, from its first row's month to its last row's.
    const statement = p.bank.id === "ws-cash";
    for (const [account, c] of covered) {
      log.run(newId("mim"), spaceId, account, c.first, c.last, c.rows, at, statement ? `${c.first.slice(0, 7)}-01` : null, statement ? monthEnd(c.last.slice(0, 7)) : null);
    }
  })();
  bus.emit({ type: "changed" });
  return { added, duplicates: p.rows.length - added };
}
