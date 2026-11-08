// Which bank a CSV came from, from its shape alone. These layouts are the documented or well-known ones, not
// checked against real downloads, so each says how sure it is and the manual column mapping stays as the fallback.
// A recognised format only suggests an account name; the user's accounts are the ones they have imported or added.
export type BankId = "td" | "amex" | "ws-cash" | "ws-chequing" | "ws-activity" | "generic";
export type Confidence = "high" | "medium" | "low";
export type Bank = { id: BankId; label: string; confidence: Confidence; account: string | null };

export const OTHER_ACCOUNT = "Imported";
export const ACCOUNT_KINDS = ["chequing", "savings", "credit card"] as const;
// How the catch-all account reads anywhere the user sees it.
export const accountLabel = (a: string) => (a === OTHER_ACCOUNT ? "Unknown account" : a);

const lower = (row: string[]) => row.map((h) => h.trim().toLowerCase());
const NUM = /^-?\$?[\d,]*\.?\d+$/;
const isNum = (s: string | undefined) => NUM.test((s ?? "").trim());
const blankOrNum = (s: string | undefined) => (s ?? "").trim() === "" || isNum(s);
const TD_DATE = /^(?:\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})$/;

// TD's EasyWeb download has no header: date, description, money out, money in, balance. It comes as MM/DD/YYYY, or
// quoted with YYYY-MM-DD dates.
function isTd(rows: string[][]): boolean {
  const sample = rows.slice(0, 20);
  return sample.length > 0 && sample.every((r) => r.length === 5 && TD_DATE.test(r[0]!.trim()) && blankOrNum(r[2]) && blankOrNum(r[3]) && isNum(r[4]));
}

// TD's card and chequing files look the same. A card statement has its payments and interest charges in it; a
// chequing account sends e-transfers and pays the card from its side.
const CARD_LINE = /payment\s*-?\s*thank you|payment received|interest charge/i;
const CHEQUING_LINE = /send e-?tfr|tfr-to c\/c/i;

const AMEX_ONLY = ["date processed", "cardmember", "card member", "extended details", "appears on your statement as", "account #"];
const WS_CASH = ["date", "transaction", "description", "amount", "balance"];
const WS_CHEQUING = ["transaction_date", "transaction_type", "status", "payee", "amount"];

export function detectBank(rows: string[][], mostlyPositive: () => boolean): Bank {
  const head = lower(rows[0] ?? []);
  if (head.includes("activity_type")) return { id: "ws-activity", label: "Wealthsimple activity", confidence: "high", account: null };
  if (WS_CHEQUING.every((c) => head.includes(c))) return { id: "ws-chequing", label: "Wealthsimple chequing", confidence: "high", account: "Wealthsimple chequing" };
  // The savings statement, with or without its currency column.
  const extra = head.filter((c) => !WS_CASH.includes(c));
  if (WS_CASH.every((c) => head.includes(c)) && extra.every((c) => c === "currency")) return { id: "ws-cash", label: "Wealthsimple savings", confidence: "medium", account: "Wealthsimple savings" };
  if (isTd(rows)) {
    const lines = (re: RegExp) => rows.filter((r) => re.test(r[1] ?? "")).length;
    return { id: "td", label: "TD", confidence: "medium", account: lines(CARD_LINE) > lines(CHEQUING_LINE) ? "TD credit card" : "TD chequing" };
  }
  const basic = ["date", "description", "amount"].every((c) => head.includes(c));
  if (basic && AMEX_ONLY.some((c) => head.includes(c))) return { id: "amex", label: "Amex", confidence: "high", account: "Amex" };
  if (basic && head.length === 3 && mostlyPositive()) return { id: "amex", label: "Amex", confidence: "medium", account: "Amex" };
  return { id: "generic", label: "Bank or card export", confidence: "low", account: null };
}

// Wealthsimple savings' own internal transfer codes. AFT and EFT aren't: a biller's pre-authorised debit and a payroll
// deposit use them too, so they count as spending or money in unless they pair with another of his accounts.
// Interac e-transfers (E_TRFIN, E_TRFOUT) can be to anyone.
export const WS_TRANSFER_CODES = /^(TRF|INTERNAL_TRANSFER)/i;
export const WS_INTEREST_CODES = /^(INT|FPLINT)$/i;
