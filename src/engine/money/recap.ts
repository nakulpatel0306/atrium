import type { Database } from "bun:sqlite";
import { etDate } from "../markets/calendar";
import { categorize, listRules, NOT_SPENDING } from "./categories";
import { monthCover, monthEnd, shiftMonth, type MonthCover } from "./coverage";
import { maskNumbers } from "./import";
import { transfers } from "./transfers";
import { txs, type Tx } from "./rows";

// "Where did my money go this month": every number here is worked out on this Mac. Claude only ever rephrases these
// facts, when Nakul asks it to.
export type RecapChange = { category: string; now: number; before: number; delta: number };
export type Notable = { date: string; merchant: string; amount: number; why: string };
export type Recap = {
  month: string;
  previous: string | null;
  spent: number;
  income: number;
  net: number;
  before: { spent: number; income: number } | null;
  lines: string[];
  changes: RecapChange[];
  notable: Notable[];
  basis: { count: number; from: string; to: string };
  moved: { count: number; total: number };
  cover: MonthCover;
};

const CHANGE_MIN = 20;
const CHANGES_SHOWN = 3;
const NOTABLE_SHOWN = 3;
const round2 = (n: number) => Math.round(n * 100) / 100;
const cad = (n: number) => `CA$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const monthFmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long" });
const monthYearFmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" });
export const monthName = (m: string) => monthFmt.format(Date.parse(`${m}-15T12:00:00Z`));
export const monthYear = (m: string) => monthYearFmt.format(Date.parse(`${m}-15T12:00:00Z`));
const dayFmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
export const dayText = (d: string) => dayFmt.format(Date.parse(`${d}T12:00:00Z`));

type Totals = { spent: number; income: number; cats: Map<string, number>; spend: (Tx & { category: string })[] };

function totals(rows: Tx[], month: string, rules: ReturnType<typeof listRules>): Totals {
  const cats = new Map<string, number>();
  const spend: Totals["spend"] = [];
  let income = 0;
  for (const t of rows) {
    if (!t.date.startsWith(month)) continue;
    const category = categorize(t.description, rules);
    if (t.amount > 0 && category !== "Transfers") income += t.amount;
    if (t.amount >= 0 || NOT_SPENDING.has(category)) continue;
    cats.set(category, (cats.get(category) ?? 0) - t.amount);
    spend.push({ ...t, category });
  }
  return { spent: round2([...cats.values()].reduce((a, b) => a + b, 0)), income: round2(income), cats, spend };
}

// The usual charge at each merchant before this month: a charge over 3× it is worth a mention.
// Rent, phone and other regular bills aren't news: a charge at a merchant that charged about the same last month is
// left out of the largest-charges part.
function notable(rows: Tx[], now: Totals, month: string): Notable[] {
  const before = new Map<string, number[]>();
  for (const t of rows) if (t.amount < 0 && t.date < `${month}-01`) before.set(t.merchant, [...(before.get(t.merchant) ?? []), -t.amount]);
  const last = shiftMonth(month, -1);
  const regular = (t: Tx) => rows.some((p) => p.merchant === t.merchant && p.date.startsWith(last) && Math.abs(-p.amount + t.amount) <= -t.amount * 0.05);
  const out: Notable[] = [];
  for (const t of [...now.spend].sort((a, b) => a.amount - b.amount)) {
    const past = (before.get(t.merchant) ?? []).sort((a, b) => a - b);
    const usual = past.length >= 2 ? past[Math.floor(past.length / 2)]! : null;
    if (usual && -t.amount > 3 * usual) out.push({ date: t.date, merchant: t.merchant, amount: round2(-t.amount), why: `More than 3× your usual at ${t.merchant}.` });
  }
  for (const t of [...now.spend].sort((a, b) => a.amount - b.amount)) {
    if (out.length >= NOTABLE_SHOWN) break;
    if (regular(t) || out.some((o) => o.date === t.date && o.merchant === t.merchant && o.amount === round2(-t.amount))) continue;
    out.push({ date: t.date, merchant: t.merchant, amount: round2(-t.amount), why: out.length ? "One of the largest charges this month." : "The largest charge this month." });
  }
  return out.slice(0, NOTABLE_SHOWN);
}

function sentences(month: string, previous: string | null, now: Totals, before: Totals | null, cover: MonthCover): string[] {
  const name = monthName(month);
  const lines: string[] = [];
  const so = cover.inProgress ? " so far" : "";
  if (before && previous && before.spent > 0) {
    const d = round2(now.spent - before.spent);
    const same = Math.abs(d) < Math.max(1, before.spent * 0.01);
    lines.push(
      same
        ? `You spent ${cad(now.spent)} in ${name}${so}, about the same as ${monthName(previous)}.`
        : `You spent ${cad(now.spent)} in ${name}${so}, ${cad(d)} ${d > 0 ? "more" : "less"} than ${monthName(previous)}.`,
    );
  } else lines.push(`You spent ${cad(now.spent)} in ${name}${so}.`);
  const net = round2(now.income - now.spent);
  lines.push(
    net >= 0
      ? `Money in was ${cad(now.income)}, so ${cad(net)} was left over.`
      : `Money in was ${cad(now.income)}, so you spent ${cad(net)} more than came in.`,
  );
  return lines;
}

export function recap(db: Database, spaceId: string, now: number, month: string): Recap | null {
  const all = txs(db, spaceId, "bank");
  const inMonth = all.filter((t) => t.date.startsWith(month));
  if (!inMonth.length) return null;
  const moved = transfers(all);
  const rows = all.filter((t) => !moved.has(t.id));
  const rules = listRules(db, spaceId);
  const previous = shiftMonth(month, -1);
  const hasPrevious = all.some((t) => t.date.startsWith(previous));
  const cur = totals(rows, month, rules);
  const prev = hasPrevious ? totals(rows, previous, rules) : null;
  const cover = monthCover(db, spaceId, month, etDate(now));
  const changes = prev
    ? [...new Set([...cur.cats.keys(), ...prev.cats.keys()])]
        .map((category) => {
          const a = round2(cur.cats.get(category) ?? 0);
          const b = round2(prev.cats.get(category) ?? 0);
          return { category, now: a, before: b, delta: round2(a - b) };
        })
        .filter((c) => Math.abs(c.delta) >= CHANGE_MIN)
        .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
        .slice(0, CHANGES_SHOWN)
    : [];
  const movedRows = inMonth.filter((t) => moved.has(t.id));
  return {
    month,
    previous: hasPrevious ? previous : null,
    spent: cur.spent,
    income: cur.income,
    net: round2(cur.income - cur.spent),
    before: prev ? { spent: prev.spent, income: prev.income } : null,
    lines: sentences(month, hasPrevious ? previous : null, cur, prev, cover),
    changes,
    notable: notable(rows, cur, month),
    basis: { count: inMonth.length, from: inMonth[0]!.date, to: inMonth.at(-1)!.date },
    moved: { count: movedRows.length, total: round2(movedRows.filter((t) => t.amount < 0).reduce((s, t) => s - t.amount, 0)) },
    cover,
  };
}

// What's missing from a month, in a few words: "TD chequing only through Oct 24 · Amex not imported".
export function coverText(cover: MonthCover): string | null {
  if (cover.inProgress) return `${monthName(cover.month)} isn't over yet.`;
  const gaps = cover.accounts.filter((a) => !a.complete).map((a) => (a.through ? `${a.account} only through ${dayText(a.through)}` : `${a.account} not imported`));
  return gaps.length ? `Incomplete: ${gaps.join(" · ")}.` : null;
}

// The recap as facts for Claude to rephrase: merchant names and Atrium's numbers only, card numbers masked.
export function recapFacts(r: Recap): string[] {
  const out = [`Recap facts for ${monthYear(r.month)}, all worked out by Atrium from files Nakul imported on this Mac (CAD):`];
  out.push(`Spent ${cad(r.spent)}; money in ${cad(r.income)}; ${r.net >= 0 ? `left over ${cad(r.net)}` : `spent ${cad(r.net)} more than came in`}.`);
  if (r.before && r.previous) out.push(`${monthYear(r.previous)}: spent ${cad(r.before.spent)}; money in ${cad(r.before.income)}.`);
  if (r.changes.length) out.push(`Biggest category changes: ${r.changes.map((c) => `${c.category} ${c.delta > 0 ? "up" : "down"} ${cad(c.delta)} (${cad(c.before)} to ${cad(c.now)})`).join("; ")}.`);
  if (r.notable.length) out.push(`Notable charges: ${r.notable.map((n) => `${maskNumbers(n.merchant)} ${cad(n.amount)} on ${n.date} (${n.why.replace(/\.$/, "")})`).join("; ")}.`);
  if (r.moved.count) out.push(`${r.moved.count} transfers between Nakul's own accounts were left out.`);
  out.push(`Based on ${r.basis.count} transactions from ${r.basis.from} to ${r.basis.to}.`);
  const gap = coverText(r.cover);
  if (gap) out.push(gap);
  return out;
}
