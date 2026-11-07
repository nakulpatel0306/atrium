// Which bank a CSV came from, from its shape alone. These layouts are the documented or well-known ones, not
// checked against Nakul's own downloads (see docs/plans/2026-11-06-plan-14-money.md), so each says how sure it is
// and the manual column mapping stays as the fallback.
export type BankId = "td" | "amex" | "ws-cash" | "ws-activity" | "generic";
export type Confidence = "high" | "medium" | "low";
export type Bank = { id: BankId; label: string; confidence: Confidence; account: string | null };

// The accounts Nakul has, for the picker on files that don't name their account.
export const ACCOUNTS = ["TD chequing", "TD credit card", "Amex", "Wealthsimple Cash"] as const;
export const OTHER_ACCOUNT = "Imported";

const lower = (row: string[]) => row.map((h) => h.trim().toLowerCase());
const NUM = /^-?\$?[\d,]*\.?\d+$/;
const isNum = (s: string | undefined) => NUM.test((s ?? "").trim());
const blankOrNum = (s: string | undefined) => (s ?? "").trim() === "" || isNum(s);
const MDY = /^\d{1,2}\/\d{1,2}\/\d{4}$/;

// TD's EasyWeb download has no header: date, description, money out, money in, balance.
function isTd(rows: string[][]): boolean {
  const sample = rows.slice(0, 20);
  return sample.length > 0 && sample.every((r) => r.length === 5 && MDY.test(r[0]!.trim()) && blankOrNum(r[2]) && blankOrNum(r[3]) && isNum(r[4]));
}

// A TD card statement has its payments from chequing in it; a chequing account has payroll and bills instead.
const CARD_PAYMENT = /payment\s*-?\s*thank you|payment received/i;

const AMEX_ONLY = ["date processed", "cardmember", "card member", "extended details", "appears on your statement as", "account #"];
const WS_CASH = ["date", "transaction", "description", "amount", "balance"];

export function detectBank(rows: string[][], mostlyPositive: () => boolean): Bank {
  const head = lower(rows[0] ?? []);
  if (head.includes("activity_type")) return { id: "ws-activity", label: "Wealthsimple activity", confidence: "high", account: null };
  if (head.length === WS_CASH.length && WS_CASH.every((c) => head.includes(c))) return { id: "ws-cash", label: "Wealthsimple Cash", confidence: "medium", account: "Wealthsimple Cash" };
  if (isTd(rows)) {
    const card = rows.some((r) => CARD_PAYMENT.test(r[1] ?? ""));
    return { id: "td", label: "TD", confidence: "medium", account: card ? "TD credit card" : "TD chequing" };
  }
  const basic = ["date", "description", "amount"].every((c) => head.includes(c));
  if (basic && AMEX_ONLY.some((c) => head.includes(c))) return { id: "amex", label: "Amex", confidence: "high", account: "Amex" };
  if (basic && head.length === 3 && mostlyPositive()) return { id: "amex", label: "Amex", confidence: "medium", account: "Amex" };
  return { id: "generic", label: "Bank or card export", confidence: "low", account: null };
}

// Wealthsimple Cash transaction codes that move money between Nakul's own accounts (pre-authorised and electronic
// funds transfers, internal transfers). Interac e-transfers (E_TRFIN, E_TRFOUT) can be to anyone, so they aren't.
export const WS_TRANSFER_CODES = /^(AFT|EFT|TRF|TRANSFER)/i;
export const WS_INTEREST_CODES = /^(INT|FPLINT)$/i;
