import { config } from "../config";

export type Session = {
  open: boolean;
  opensAt: number | null;
  closesAt: number | null;
  nextOpen: number;
  earlyClose: boolean;
  holiday: string | null;
};

const TZ = "America/New_York";
const DAY_MS = 86_400_000;

const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function etParts(ms: number): { date: string; hhmm: string } {
  const p = Object.fromEntries(partsFmt.formatToParts(ms).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hhmm: `${p.hour}:${p.minute}` };
}

export const etDate = (ms: number): string => etParts(ms).date;

const clockFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true });
export const etClock = (ms: number): string => `${clockFmt.format(ms)} ET`;

// ET is UTC−4 or UTC−5; the right one is whichever reads back as the same wall-clock time.
export function etInstant(date: string, hhmm: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [hh, mm] = hhmm.split(":").map(Number) as [number, number];
  for (const offset of [4, 5]) {
    const t = Date.UTC(y, m - 1, d, hh + offset, mm);
    const p = etParts(t);
    if (p.date === date && p.hhmm === hhmm) return t;
  }
  return Date.UTC(y, m - 1, d, hh + 5, mm);
}

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const weekday = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();

function nthWeekday(y: number, m: number, dow: number, n: number): string {
  const first = weekday(y, m, 1);
  return iso(y, m, 1 + ((dow - first + 7) % 7) + (n - 1) * 7);
}

function lastWeekday(y: number, m: number, dow: number): string {
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return iso(y, m, last - ((weekday(y, m, last) - dow + 7) % 7));
}

// Saturday holidays move to Friday, Sunday ones to Monday.
function observed(y: number, m: number, d: number): string {
  const dow = weekday(y, m, d);
  const shift = dow === 6 ? -1 : dow === 0 ? 1 : 0;
  const t = new Date(Date.UTC(y, m - 1, d + shift));
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

// Anonymous Gregorian computus.
function easter(y: number): { m: number; d: number } {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const mm = Math.floor((a + 11 * h + 22 * l) / 451);
  return { m: Math.floor((h + l - 7 * mm + 114) / 31), d: ((h + l - 7 * mm + 114) % 31) + 1 };
}

export function usHolidays(year: number): { date: string; name: string }[] {
  const out: { date: string; name: string }[] = [];
  // NYSE doesn't observe a Saturday New Year on the Friday before (that Friday is the prior year's last session).
  if (weekday(year, 1, 1) !== 6) out.push({ date: observed(year, 1, 1), name: "New Year's Day" });
  out.push({ date: nthWeekday(year, 1, 1, 3), name: "Martin Luther King Jr. Day" });
  out.push({ date: nthWeekday(year, 2, 1, 3), name: "Washington's Birthday" });
  const e = easter(year);
  const gf = new Date(Date.UTC(year, e.m - 1, e.d - 2));
  out.push({ date: iso(year, gf.getUTCMonth() + 1, gf.getUTCDate()), name: "Good Friday" });
  out.push({ date: lastWeekday(year, 5, 1), name: "Memorial Day" });
  out.push({ date: observed(year, 6, 19), name: "Juneteenth" });
  out.push({ date: observed(year, 7, 4), name: "Independence Day" });
  out.push({ date: nthWeekday(year, 9, 1, 1), name: "Labor Day" });
  out.push({ date: nthWeekday(year, 11, 4, 4), name: "Thanksgiving Day" });
  out.push({ date: observed(year, 12, 25), name: "Christmas Day" });
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export function usEarlyCloses(year: number): string[] {
  const holidays = new Set(usHolidays(year).map((h) => h.date));
  const out: string[] = [];
  for (const [m, d] of [[7, 3], [12, 24]] as const) {
    const dow = weekday(year, m, d);
    const date = iso(year, m, d);
    if (dow !== 0 && dow !== 6 && !holidays.has(date)) out.push(date);
  }
  const thanks = nthWeekday(year, 11, 4, 4);
  const dayAfter = new Date(Date.parse(`${thanks}T12:00:00Z`) + DAY_MS);
  out.push(iso(year, dayAfter.getUTCMonth() + 1, dayAfter.getUTCDate()));
  return out.sort();
}

// Weekend holidays move to the Monday after (TSX doesn't close the Friday before).
function observedMonday(y: number, m: number, d: number): string {
  const dow = weekday(y, m, d);
  const t = new Date(Date.UTC(y, m - 1, d + (dow === 6 ? 2 : dow === 0 ? 1 : 0)));
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

export function tsxHolidays(year: number): { date: string; name: string }[] {
  const e = easter(year);
  const gf = new Date(Date.UTC(year, e.m - 1, e.d - 2));
  const christmas = observedMonday(year, 12, 25);
  // Boxing Day is the next weekday after Christmas is observed.
  const boxing = observedMonday(...(addDays(christmas, 1).split("-").map(Number) as [number, number, number]));
  const out = [
    { date: observedMonday(year, 1, 1), name: "New Year's Day" },
    { date: nthWeekday(year, 2, 1, 3), name: "Family Day" },
    { date: iso(year, gf.getUTCMonth() + 1, gf.getUTCDate()), name: "Good Friday" },
    // The Monday before May 25.
    { date: iso(year, 5, 24 - ((weekday(year, 5, 24) + 6) % 7)), name: "Victoria Day" },
    { date: observedMonday(year, 7, 1), name: "Canada Day" },
    { date: nthWeekday(year, 8, 1, 1), name: "Civic Holiday" },
    { date: nthWeekday(year, 9, 1, 1), name: "Labour Day" },
    { date: nthWeekday(year, 10, 1, 2), name: "Thanksgiving Day" },
    { date: christmas, name: "Christmas Day" },
    { date: boxing, name: "Boxing Day" },
  ];
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

function tsxTrading(date: string): boolean {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const dow = weekday(y, m, d);
  return dow !== 0 && dow !== 6 && !tsxHolidays(y).some((h) => h.date === date);
}

// Toronto's regular session, in ET. Early closes aren't modelled: a late price just stops being live.
export function tsxOpen(now: number): boolean {
  const { date, hhmm } = etParts(now);
  return tsxTrading(date) && hhmm >= "09:30" && hhmm < "16:00";
}

// The next 9:30 ET open after `now` (today's, if it's still ahead).
export function tsxNextOpen(now: number): number {
  let date = etDate(now);
  for (let i = 0; i < 10; i++, date = addDays(date, 1)) {
    const open = etInstant(date, "09:30");
    if (tsxTrading(date) && open > now) return open;
  }
  return etInstant(date, "09:30");
}

type Day = { trading: boolean; holiday: string | null; early: boolean };

function dayInfo(date: string): Day {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const dow = weekday(y, m, d);
  const holiday = usHolidays(y).find((h) => h.date === date)?.name ?? null;
  return { trading: dow !== 0 && dow !== 6 && !holiday, holiday, early: usEarlyCloses(y).includes(date) };
}

const nextDate = (date: string) => new Date(Date.parse(`${date}T12:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

export function usSession(now: number): Session {
  const today = etDate(now);
  const info = dayInfo(today);
  const opensAt = info.trading ? etInstant(today, "09:30") : null;
  const closesAt = info.trading ? etInstant(today, info.early ? "13:00" : "16:00") : null;
  const open = opensAt !== null && closesAt !== null && now >= opensAt && now < closesAt;
  let nextOpen = opensAt !== null && now < opensAt ? opensAt : 0;
  let date = today;
  for (let i = 0; i < 10 && !nextOpen; i++) {
    date = nextDate(date);
    if (dayInfo(date).trading) nextOpen = etInstant(date, "09:30");
  }
  return { open, opensAt, closesAt, nextOpen, earlyClose: info.early, holiday: info.holiday };
}

const loadedAt = Date.now();

// Demo mode can shift the market clock (ATRIUM_MARKET_NOW) so demos and e2e runs can be in-session at any hour.
// Real data always uses the real clock.
export function marketNow(provider: string): number {
  const shifted = config().marketNow;
  if (provider !== "demo" || !shifted) return Date.now();
  const at = Date.parse(shifted);
  return Number.isNaN(at) ? Date.now() : Date.now() + (at - loadedAt);
}

// The most recent session whose close has passed: its date and closing instant.
export function lastCompletedSession(now: number): { date: string; closesAt: number } {
  let date = etDate(now);
  for (let i = 0; i < 12; i++) {
    const s = usSession(etInstant(date, "12:00"));
    if (s.closesAt !== null && s.closesAt <= now) return { date, closesAt: s.closesAt };
    date = new Date(Date.parse(`${date}T12:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
  }
  return { date, closesAt: etInstant(date, "16:00") };
}
