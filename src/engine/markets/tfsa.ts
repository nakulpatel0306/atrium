import type { Database } from "bun:sqlite";
import { newId } from "../ids";
import { etDate } from "./calendar";
import type { Position } from "./health";
import { money } from "./labels";
import { fxLabel, toCad, type Sourced } from "./sourced";

// TFSA facts Atrium can be sure of: US dividends lose 15% there, gains aren't taxed (so no ACB tooling), and
// contribution room comes only from numbers Nakul types in (CRA's figure can't be fetched).
export const US_WITHHOLDING = 0.15;
export const isTfsa = (account: string): boolean => /tfsa/i.test(account);
const DIVIDEND_SOURCE = "Tiingo dividends · last 12 months";
const US_NOTE = "15% US withholding tax is taken from these dividends in a TFSA and can't be recovered.";
const FUND_NOTE = "About 15% US withholding is taken inside the fund before distributions; it can't be recovered in a TFSA.";
const YEAR_MS = 365 * 86_400_000;

export function withholdingNote(p: { key: string; account: string; listingCcy: "CAD" | "USD"; ttmDividend: number; usExposure: number }): string | null {
  if (!isTfsa(p.account)) return null;
  if (p.listingCcy === "USD") return p.ttmDividend > 0 ? US_NOTE : null;
  return p.usExposure > 0.2 ? FUND_NOTE : null;
}

export function ttmDividends(db: Database, key: string, now: number): number {
  const r = db.query("SELECT COALESCE(SUM(amount), 0) AS s FROM market_dividends WHERE key = ? AND ex_date > ? AND ex_date <= ?").get(key, etDate(now - YEAR_MS), etDate(now)) as { s: number };
  return r.s;
}

export type IncomeRow = { key: string; gross: number; net: number; ccy: "CAD" | "USD"; source: string; note: string | null };

export function incomeTtm(
  db: Database,
  positions: Position[],
  fx: Sourced | null,
  now: number = Date.now(),
): { rows: IncomeRow[]; totalNetCad: Sourced | null; unavailable: { key: string; reason: string }[] } {
  const rows: IncomeRow[] = [];
  const unavailable: { key: string; reason: string }[] = [];
  const grouped = new Map<string, { key: string; account: string; quantity: number; ccy: "CAD" | "USD" }>();
  for (const p of positions) {
    const id = `${p.key}|${isTfsa(p.account)}`;
    const g = grouped.get(id) ?? { key: p.key, account: p.account, quantity: 0, ccy: p.listingCcy };
    g.quantity += p.quantity;
    grouped.set(id, g);
  }
  for (const g of grouped.values()) {
    if (g.ccy === "CAD") {
      if (!unavailable.some((u) => u.key === g.key)) unavailable.push({ key: g.key, reason: `No free source for ${g.key} distributions yet.` });
      continue;
    }
    const perShare = ttmDividends(db, g.key, now);
    if (perShare <= 0) continue;
    const gross = perShare * g.quantity;
    const tfsa = isTfsa(g.account);
    rows.push({ key: g.key, gross, net: tfsa ? gross * (1 - US_WITHHOLDING) : gross, ccy: "USD", source: DIVIDEND_SOURCE, note: tfsa ? US_NOTE : null });
  }
  const cad = rows.map((r) => toCad(r.net, r.ccy, fx));
  const totalNetCad: Sourced | null =
    rows.length && cad.every((v) => v !== null)
      ? { value: cad.reduce((a, v) => a! + v!, 0)!, source: fx ? `${DIVIDEND_SOURCE} · ${fxLabel(fx)}` : DIVIDEND_SOURCE, asOf: now, tone: "official" }
      : null;
  return { rows, totalNetCad, unavailable };
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function setRoom(db: Database, year: number, roomJan1: number): void {
  if (!Number.isInteger(year) || year < 2009 || year > 2100) throw new Error("Pick a year from 2009 on.");
  if (!Number.isFinite(roomJan1) || roomJan1 < 0) throw new Error("The room can't be negative.");
  db.query("INSERT INTO tfsa_room (year, room_jan1, updated_at) VALUES (?, ?, ?) ON CONFLICT(year) DO UPDATE SET room_jan1 = excluded.room_jan1, updated_at = excluded.updated_at").run(year, roomJan1, Date.now());
}

export function addEntry(db: Database, e: { date: string; kind: "contribution" | "withdrawal"; amount: number; note?: string }): string {
  if (typeof e.date !== "string" || !ISO.test(e.date) || Number.isNaN(Date.parse(e.date))) throw new Error("Use a date like 2026-08-01.");
  if (e.kind !== "contribution" && e.kind !== "withdrawal") throw new Error("Pick contribution or withdrawal.");
  if (!Number.isFinite(e.amount) || e.amount <= 0) throw new Error("The amount must be more than zero.");
  const id = newId("tfs");
  db.query("INSERT INTO tfsa_entries (id, date, kind, amount, note, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, e.date, e.kind, e.amount, (e.note ?? "").slice(0, 500), Date.now());
  return id;
}

export function removeEntry(db: Database, id: string): void {
  db.query("DELETE FROM tfsa_entries WHERE id = ?").run(id);
}

export type TfsaEntry = { id: string; date: string; kind: "contribution" | "withdrawal"; amount: number; note: string };
export function listEntries(db: Database, year: number): TfsaEntry[] {
  return db.query("SELECT id, date, kind, amount, note FROM tfsa_entries WHERE date LIKE ? ORDER BY date DESC, created_at DESC").all(`${year}-%`) as TfsaEntry[];
}

export function roomStatus(db: Database, year: number) {
  const room = db.query("SELECT room_jan1 FROM tfsa_room WHERE year = ?").get(year) as { room_jan1: number } | null;
  const sum = (kind: string) => (db.query("SELECT COALESCE(SUM(amount), 0) AS s FROM tfsa_entries WHERE kind = ? AND date LIKE ?").get(kind, `${year}-%`) as { s: number }).s;
  const contributed = sum("contribution");
  const withdrawn = sum("withdrawal");
  // Withdrawals come back as room on January 1 of the next year, not now.
  const remaining = room ? room.room_jan1 - contributed : null;
  const over = remaining === null ? 0 : Math.max(0, -remaining);
  const text =
    remaining === null
      ? "Enter your room from CRA My Account (it isn't fetched)."
      : over > 0
        ? `Over by ${money(over, "CAD")}: CRA charges 1% a month on the excess until it's withdrawn.`
        : `${money(remaining, "CAD")} of room left for ${year}.`;
  return { year, roomJan1: room?.room_jan1 ?? null, contributed, withdrawn, remaining, addsBackNextYear: withdrawn, over, text };
}
