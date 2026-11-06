import type { Database } from "bun:sqlite";
import type { FundFile, FundLine } from "./types";

// The last good file per fund. A failed refresh only records its error, so the old lines stay in use with their date.
export function saveFundFile(db: Database, file: FundFile, fetchedAt: number): void {
  const put = db.query(
    "INSERT INTO fund_lines (fund, rank, ticker, key, name, weight, kind, sector, country, currency, via) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  db.transaction(() => {
    db.query("DELETE FROM fund_lines WHERE fund = ?").run(file.fund);
    file.lines.forEach((l, i) => put.run(file.fund, i, l.ticker, l.key, l.name, l.weight, l.kind, l.sector, l.country, l.currency, l.via));
    db.query(
      `INSERT INTO fund_files (fund, source, as_of, fetched_at, note, last_error, last_attempt_at) VALUES (?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT(fund) DO UPDATE SET source = excluded.source, as_of = excluded.as_of, fetched_at = excluded.fetched_at,
         note = excluded.note, last_error = NULL, last_attempt_at = excluded.last_attempt_at`,
    ).run(file.fund, file.source, file.asOf, fetchedAt, file.note, fetchedAt);
  })();
}

export function noteFundError(db: Database, fund: string, message: string, at: number): void {
  const before = fundError(db, fund);
  if (before !== message) console.error(`Fund holdings ${fund}: ${message}`);
  const updated = db.query("UPDATE fund_files SET last_error = ?, last_attempt_at = ? WHERE fund = ?").run(message, at, fund).changes;
  // A fund that never had a good file still records why, without lines (as_of '' marks "no file").
  if (!updated) {
    db.query("INSERT INTO fund_files (fund, source, as_of, fetched_at, note, last_error, last_attempt_at) VALUES (?, '', '', 0, NULL, ?, ?)").run(fund, message, at);
  }
}

type FileRow = { fund: string; source: FundFile["source"]; as_of: string; fetched_at: number; note: string | null; last_error: string | null };

export function loadFundFile(db: Database, fund: string): (FundFile & { fetchedAt: number; lastError: string | null }) | null {
  const f = db.query("SELECT fund, source, as_of, fetched_at, note, last_error FROM fund_files WHERE fund = ?").get(fund) as FileRow | null;
  if (!f || !f.as_of) return null;
  const lines = db.query("SELECT ticker, key, name, weight, kind, sector, country, currency, via FROM fund_lines WHERE fund = ? ORDER BY rank").all(fund) as FundLine[];
  return { fund: f.fund, source: f.source, asOf: f.as_of, lines, note: f.note, fetchedAt: f.fetched_at, lastError: f.last_error };
}

// The error of a fund that has never had a good file, for "Breakdown unavailable: <reason>".
export function fundError(db: Database, fund: string): string | null {
  const f = db.query("SELECT last_error FROM fund_files WHERE fund = ?").get(fund) as { last_error: string | null } | null;
  return f?.last_error ?? null;
}
