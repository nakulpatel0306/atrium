import type { Database } from "bun:sqlite";
import { etDate } from "../markets/calendar";

// Which days Nakul's imports cover, per account, from the import log. A file only shows the days that had
// something on them, so a month is complete for an account when its files start in the first week and either reach
// the last 3 days, or were imported after the month ended and reach its last week (the quiet days were just quiet).
// A statement file (Wealthsimple savings) covers its whole period, whatever days had activity.
export type AccountCover = { account: string; complete: boolean; through: string | null };
export type MonthCover = { month: string; inProgress: boolean; complete: boolean; accounts: AccountCover[] };

const END_DAYS = 3;
const QUIET_DAYS = 7;
const ACTIVE_DAYS = 92;
const DAY_MS = 86_400_000;

export const monthStart = (month: string) => `${month}-01`;
export function monthEnd(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
}
export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1 + by, 1)).toISOString().slice(0, 7);
}
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

type Import = { account: string; first_date: string; last_date: string; imported_at: number };

// Bank and card accounts he has imported in the three months before this one's end: an account he stopped using
// stops counting.
function activeAccounts(imports: Import[], month: string): string[] {
  const since = addDays(monthStart(month), -ACTIVE_DAYS);
  return [...new Set(imports.filter((i) => i.last_date >= since && i.first_date <= monthEnd(month)).map((i) => i.account))].sort();
}

export function monthCover(db: Database, spaceId: string, month: string, today: string): MonthCover {
  const imports = db
    .query(
      `SELECT account, COALESCE(period_start, first_date) AS first_date, COALESCE(period_end, last_date) AS last_date, imported_at FROM money_imports i WHERE space_id = ?
       AND EXISTS (SELECT 1 FROM money_transactions t WHERE t.space_id = i.space_id AND t.account = i.account AND t.source = 'bank')`,
    )
    .all(spaceId) as Import[];
  const start = monthStart(month);
  const end = monthEnd(month);
  const inProgress = today <= end && today >= start;
  const accounts = activeAccounts(imports, month).map((account): AccountCover => {
    const mine = imports.filter((i) => i.account === account && i.last_date >= start && i.first_date <= end);
    if (!mine.length) return { account, complete: false, through: null };
    const first = mine.reduce((m, i) => (i.first_date < m ? i.first_date : m), mine[0]!.first_date);
    const last = mine.reduce((m, i) => (i.last_date > m ? i.last_date : m), mine[0]!.last_date);
    const afterEnd = mine.some((i) => etDate(i.imported_at) > end);
    const reachesEnd = last >= addDays(end, -(END_DAYS - 1)) || (afterEnd && last >= addDays(end, -(QUIET_DAYS - 1)));
    const complete = !inProgress && first <= addDays(start, QUIET_DAYS - 1) && reachesEnd;
    return { account, complete, through: last > end ? end : last };
  });
  return { month, inProgress, complete: !inProgress && accounts.length > 0 && accounts.every((a) => a.complete), accounts };
}
