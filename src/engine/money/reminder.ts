import type { Database } from "bun:sqlite";
import { etDate } from "../markets/calendar";
import { getSetting, setSetting } from "../settings";
import { listSpaces } from "../spaces";
import { accountLabel } from "./banks";
import { checkBudgets } from "./budgets";
import { monthCover, shiftMonth } from "./coverage";
import { addNudge, hasNudge, settleNudge } from "./nudges";
import { monthName } from "./recap";

const REMIND_FROM_DAY = 2;
const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

// From the 2nd of a month: if an account Nakul has imported before isn't complete for last month, one reminder
// names it. Nothing if he has never imported, or already has; the reminder clears itself once the import is in.
export function importReminder(db: Database, spaceId: string, now: number): void {
  const today = etDate(now);
  const last = shiftMonth(today.slice(0, 7), -1);
  const key = `import:${last}`;
  const cover = monthCover(db, spaceId, last, today);
  const missing = cover.accounts.filter((a) => !a.complete).map((a) => accountLabel(a.account));
  if (!missing.length) return settleNudge(db, spaceId, key, now);
  if (Number(today.slice(8, 10)) < REMIND_FROM_DAY || hasNudge(db, spaceId, key)) return;
  const name = monthName(last);
  addNudge(db, spaceId, "import", key, `Time to import ${name}`, `${list(missing)} ${missing.length === 1 ? "isn't" : "aren't"} imported for ${name} yet.`, now);
}

// Once a day, from the runner's minute check: the reminder and budget heads-ups for every investing space.
export function moneyDaily(db: Database, now: number): void {
  const today = etDate(now);
  if (getSetting(db, "money.lastDaily") === today) return;
  for (const space of listSpaces(db).filter((s) => s.kind === "markets")) {
    importReminder(db, space.id, now);
    checkBudgets(db, space.id, now);
  }
  // Only once the day's checks ran, so one that throws is tried again on the next minute's tick.
  setSetting(db, "money.lastDaily", today);
}
