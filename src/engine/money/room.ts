import type { Database } from "bun:sqlite";
import { roomStatus } from "../markets/tfsa";

// TFSA room left this year, from the room Nakul typed in (CRA's figure can't be fetched) minus this year's
// contributions. Those come from his imported Wealthsimple TFSA deposits when there are any, otherwise from the
// entries he logged by hand: never both, so nothing counts twice. Facts, not advice.
export type Room = {
  year: number;
  roomJan1: number | null;
  contributed: number;
  left: number | null;
  over: number;
  source: "imported" | "logged" | "none";
  through: string | null;
  headline: string;
  from: string | null;
  todo: string | null;
};

const cad = (n: number) => `CA$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const round2 = (n: number) => Math.round(n * 100) / 100;
const dayFmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });

export function tfsaRoom(db: Database, spaceId: string, year: number): Room {
  const status = roomStatus(db, year);
  const imported = db
    .query(
      `SELECT COALESCE(SUM(ABS(amount)), 0) AS total, COUNT(*) AS n, MAX(date) AS last FROM money_transactions
       WHERE space_id = ? AND source = 'wealthsimple' AND kind = 'deposit' AND lower(account) LIKE '%tfsa%' AND date LIKE ?`,
    )
    .get(spaceId, `${year}-%`) as { total: number; n: number; last: string | null };
  const anyActivity = db.query("SELECT MAX(date) AS last FROM money_transactions WHERE space_id = ? AND source = 'wealthsimple' AND date LIKE ?").get(spaceId, `${year}-%`) as { last: string | null };
  const source: Room["source"] = imported.n > 0 ? "imported" : status.contributed > 0 ? "logged" : anyActivity.last ? "imported" : "none";
  const contributed = round2(source === "imported" ? imported.total : status.contributed);
  const through = source === "imported" ? anyActivity.last : null;
  const left = status.roomJan1 === null ? null : round2(status.roomJan1 - contributed);
  const over = left === null ? 0 : Math.max(0, -left);

  const headline =
    left === null ? `Your ${year} TFSA room isn't set yet.` : over > 0 ? `Over your ${year} TFSA room by ${cad(over)}.` : `${cad(left)} of TFSA room left for ${year}.`;
  const counted =
    source === "imported"
      ? `${cad(contributed)} deposited (your Wealthsimple activity${through ? `, through ${dayFmt.format(Date.parse(`${through}T12:00:00Z`))}` : ""})`
      : source === "logged"
        ? `${cad(contributed)} contributed (entries you logged)`
        : null;
  const from = status.roomJan1 === null ? null : counted ? `${cad(status.roomJan1)} on Jan 1 (you entered it) minus ${counted}.` : `${cad(status.roomJan1)} on Jan 1 (you entered it). No deposits counted yet.`;
  const todo =
    status.roomJan1 === null
      ? "Enter your Jan 1 room from CRA My Account."
      : source === "none"
        ? "Import your Wealthsimple activity export so this year's deposits count."
        : over > 0
          ? "CRA charges 1% a month on the excess until it's withdrawn."
          : null;
  return { year, roomJan1: status.roomJan1, contributed, left, over, source, through, headline, from, todo };
}

// The recap's tie-in: what was left over this month next to the room left. Only when both are known.
export function roomTie(net: number, monthName: string, room: Room): string | null {
  if (net <= 0 || room.left === null || room.over > 0) return null;
  return `You had ${cad(net)} left over in ${monthName}. You have ${cad(room.left)} of TFSA room for ${room.year}.`;
}
