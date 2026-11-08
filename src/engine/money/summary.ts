import type { Database } from "bun:sqlite";
import { createTask, listTasks, type Task } from "../tasks";
import { etDate } from "../markets/calendar";
import { latestWriteups, type Writeup } from "../markets/research";
import { listEntries, roomStatus } from "../markets/tfsa";
import { listRules, NOT_SPENDING, type Rule } from "./categories";
import { isMasked, maskNumbers } from "./import";
import { budgetRows, listBudgets, type BudgetRow } from "./budgets";
import { monthCover } from "./coverage";
import { coverText, dayText, monthName, monthYear, recap, recapFacts, type Recap } from "./recap";
import { roomTie, tfsaRoom, type Room } from "./room";
import { subscriptions, type SubscriptionList } from "./subscriptions";
import { transfers, type TransferWhy } from "./transfers";
import { countAs, counted, movedIn, spendingIn, txs, type Tx } from "./rows";
import type { Flow } from "./flows";
import { knownAccounts, listImports, moneyBusy, type ImportRow } from "./imports";


export type Recurring = { merchant: string; amount: number; count: number; last: string; next: string };
export type Unusual = { date: string; merchant: string; amount: number; reason: string };
export type WsYear = {
  year: string;
  deposits: number;
  tfsaDeposits: number;
  withdrawals: number;
  dividends: number;
  fees: number;
  buys: number;
  sells: number;
  // USD activity, kept apart: nothing is converted without a rate.
  usd: { buys: number; sells: number; dividends: number };
};
export type MoneyView = {
  months: string[];
  month: string | null;
  spending: { category: string; amount: number; count: number }[];
  spent: number;
  income: number;
  recurring: Recurring[];
  unusual: Unusual[];
  ws: WsYear[];
  counts: { bank: number; wealthsimple: number };
  range: { from: string; to: string } | null;
  accounts: string[];
  rules: number;
  recap: Recap | null;
  // What the recap's month is missing, or null when the imports cover all of it.
  coverLine: string | null;
  tie: string | null;
  subscriptions: SubscriptionList;
  room: Room;
  budgets: BudgetRow[];
  // Categories a budget can be set for: the rule list's spending ones, plus any seen this month.
  categories: string[];
  transactions: MonthTx[];
  asks: (Writeup & { question: string; status: "queued" | "running" | "done" | "failed"; taskId: string | null })[];
  imports: ImportRow[];
  // The accounts an import can be moved to.
  importAccounts: string[];
  // True while a Claude money run is queued or going; imports can't be undone or moved then.
  busy: boolean;
};

// flow is Atrium's stored call on the row (a card payment, a refund, a bill for a card that isn't imported), so the
// list can say why it counts the way it does.
export type MonthTx = { id: string; date: string; description: string; account: string; amount: number; category: string; transfer: TransferWhy | null; mark: number | null; flow: Flow | null };

export const STARTERS = [
  "How much did I get in dividends this year?",
  "What did I put into my TFSA in 2026?",
  "Where did my money go last month?",
  "Any subscriptions I forgot about?",
];
export const MONEY_ASK_MAX = 500;
const DAY_MS = 86_400_000;
const UNUSUAL_DAYS = 90;
const UNUSUAL_SHOWN = 10;
const USUAL_WINDOW = 20;
const TWIN_MIN = 20;
const round2 = (n: number) => Math.round(n * 100) / 100;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const days = (a: string, b: string) => (Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY_MS;
const nextMonth = (date: string) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
};

// Each merchant's charges in date order; rows arrive sorted, so one pass keeps the summary linear.
function byMerchant(spend: Tx[]): Map<string, Tx[]> {
  const by = new Map<string, Tx[]>();
  for (const t of spend) {
    const list = by.get(t.merchant);
    if (list) list.push(t);
    else by.set(t.merchant, [t]);
  }
  return by;
}

// Fixed amounts (within 5%) at least three times, each about a month apart: subscriptions, rent, phone bills.
function recurring(by: Map<string, Tx[]>): Recurring[] {
  const out: Recurring[] = [];
  for (const [merchant, list] of by) {
    if (list.length < 3) continue;
    const gaps = list.slice(1).map((t, i) => days(list[i]!.date, t.date));
    const amounts = list.map((t) => -t.amount);
    const typical = median(amounts);
    if (!gaps.every((g) => g >= 25 && g <= 35) || !amounts.every((a) => Math.abs(a - typical) <= typical * 0.05)) continue;
    const last = list.at(-1)!;
    out.push({ merchant, amount: round2(-last.amount), count: list.length, last: last.date, next: nextMonth(last.date) });
  }
  return out.sort((a, b) => b.amount - a.amount);
}

// In the last 90 days of data, the most unusual few: more than 3× the usual at that place (the median of its
// previous charges), ranked by how far over, then a repeat of the same amount there within 3 days. Repeats under
// CA$20 (a daily coffee) aren't worth a look.
function unusual(by: Map<string, Tx[]>, end: string | undefined): Unusual[] {
  if (!end) return [];
  const found: (Unusual & { score: number })[] = [];
  for (const [merchant, list] of by) {
    const lastSeen = new Map<number, string>();
    list.forEach((t, i) => {
      const amount = -t.amount;
      const previous = lastSeen.get(t.amount);
      lastSeen.set(t.amount, t.date);
      if (days(t.date, end) > UNUSUAL_DAYS) return;
      const before = list.slice(Math.max(0, i - USUAL_WINDOW), i).map((p) => -p.amount);
      const usual = before.length >= 2 ? median(before) : null;
      if (usual && amount > 3 * usual) {
        found.push({ date: t.date, merchant, amount: round2(amount), reason: `More than 3× your usual at ${merchant}.`, score: amount / usual });
      } else if (previous && amount >= TWIN_MIN && days(previous, t.date) <= 3) {
        found.push({ date: t.date, merchant, amount: round2(amount), reason: `Same amount at ${merchant} within 3 days.`, score: 1 });
      }
    });
  }
  return found
    .sort((a, b) => b.score - a.score || b.amount - a.amount || b.date.localeCompare(a.date))
    .slice(0, UNUSUAL_SHOWN)
    .map(({ score: _score, ...u }) => u);
}

function wsYears(rows: Tx[]): WsYear[] {
  const by = new Map<string, WsYear>();
  for (const t of rows) {
    const year = t.date.slice(0, 4);
    const y = by.get(year) ?? { year, deposits: 0, tfsaDeposits: 0, withdrawals: 0, dividends: 0, fees: 0, buys: 0, sells: 0, usd: { buys: 0, sells: 0, dividends: 0 } };
    const a = Math.abs(t.amount);
    const usd = t.currency === "USD";
    if (t.kind === "deposit") {
      y.deposits += a;
      if (/tfsa/i.test(t.account)) y.tfsaDeposits += a;
    } else if (t.kind === "withdrawal") y.withdrawals += a;
    else if (t.kind === "fee") y.fees += a;
    else if (t.kind === "dividend") usd ? (y.usd.dividends += a) : (y.dividends += a);
    else if (t.kind === "buy") usd ? (y.usd.buys += a) : (y.buys += a);
    else if (t.kind === "sell") usd ? (y.usd.sells += a) : (y.sells += a);
    by.set(year, y);
  }
  const r2 = (y: WsYear): WsYear => ({
    ...y,
    ...Object.fromEntries((["deposits", "tfsaDeposits", "withdrawals", "dividends", "fees", "buys", "sells"] as const).map((k) => [k, round2(y[k])])),
    usd: { buys: round2(y.usd.buys), sells: round2(y.usd.sells), dividends: round2(y.usd.dividends) },
  });
  return [...by.values()].sort((a, b) => b.year.localeCompare(a.year)).map(r2);
}

function asks(db: Database, spaceId: string): MoneyView["asks"] {
  const tasks = listTasks(db, { spaceId }).filter((t) => t.purpose === "money");
  const byTask = new Map(tasks.map((t) => [t.id, t]));
  const open = tasks
    .filter((t) => t.status === "queued" || t.status === "running")
    .map((t) => ({ id: t.id, kind: "money", key: null, forDate: new Date(t.createdAt).toISOString(), body: "", taskId: t.id, createdAt: t.createdAt, question: t.detail, status: t.status as "queued" | "running" }));
  const done = latestWriteups(db, spaceId, { kind: "money", limit: 3 }).map((w) => {
    const t = w.taskId ? byTask.get(w.taskId) : undefined;
    return { ...w, question: t?.detail ?? "", status: (t?.status === "failed" ? "failed" : "done") as "done" | "failed" };
  });
  return [...open, ...done].slice(0, 3);
}

export function moneyView(db: Database, spaceId: string, now: number, month?: string): MoneyView {
  const all = txs(db, spaceId, "bank");
  const bank = counted(all);
  const ws = txs(db, spaceId, "wealthsimple");
  const rules = listRules(db, spaceId);
  const months = [...new Set(all.map((t) => t.date.slice(0, 7)))].sort().reverse();
  const current = etDate(now).slice(0, 7);
  // The latest month the imports fully cover, so a recap opens on a finished month rather than two days of the next.
  const today = etDate(now);
  const complete = months.find((m) => monthCover(db, spaceId, m, today).complete);
  const picked = month && months.includes(month) ? month : (complete ?? (months.includes(current) ? current : (months[0] ?? null)));
  const r = picked ? recap(db, spaceId, now, picked) : null;
  const room = tfsaRoom(db, spaceId, Number(today.slice(0, 4)));
  const monthSpending = spendingIn(bank, picked, rules);
  const { spending, spent, income } = monthSpending;
  const moved = transfers(all);
  const spend = bank.filter((t) => countAs(t, rules).as === "spend");
  const merchants = byMerchant(spend);
  return {
    months,
    month: picked,
    spending,
    spent,
    income,
    recurring: recurring(merchants),
    unusual: unusual(merchants, spend.at(-1)?.date),
    ws: wsYears(ws),
    counts: { bank: all.length, wealthsimple: ws.length },
    range: all.length ? { from: all[0]!.date, to: all.at(-1)!.date } : null,
    accounts: [...new Set(all.map((t) => t.account))],
    rules: rules.length,
    recap: r,
    coverLine: r ? coverText(r.cover) : null,
    tie: r ? roomTie(r.net, monthName(r.month), room) : null,
    subscriptions: subscriptions(bank, rules),
    room,
    budgets: budgetRows(listBudgets(db, spaceId), monthSpending.spending),
    categories: [...new Set([...rules.map((x) => x.category).filter((c) => !NOT_SPENDING.has(c)), "Other", ...monthSpending.spending.map((c) => c.category)])].sort(),
    transactions: picked
      ? all
          .filter((t) => t.date.startsWith(picked))
          .reverse()
          .map((t) => ({ id: t.id, date: t.date, description: t.description, account: t.account, amount: t.amount, category: countAs(t, rules).category, transfer: moved.get(t.id) ?? null, mark: t.transfer, flow: t.flow }))
      : [],
    asks: asks(db, spaceId),
    imports: listImports(db, spaceId),
    importAccounts: knownAccounts(db, spaceId),
    busy: moneyBusy(db, spaceId),
  };
}

// The Money view without anything row by row: no transactions, unusual charges, recurring list, Wealthsimple years
// or import list. It's what the terminal app reads, so no transaction text ever reaches it, masked or not.
export type MoneySummary = Omit<MoneyView, "transactions" | "unusual" | "recurring" | "ws" | "imports" | "importAccounts"> & { lastImportAt: number | null };

export function moneySummary(v: MoneyView): MoneySummary {
  const { transactions: _t, unusual: _u, recurring: _r, ws: _w, imports, importAccounts: _a, recap, ...rest } = v;
  // The recap's largest charges are real rows (date, merchant, amount); the terminal app only needs its totals.
  return { ...rest, recap: recap && { ...recap, notable: [] }, lastImportAt: imports[0]?.importedAt ?? null };
}

const cad = (n: number) => `CA$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const usd = (n: number) => `US$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const both = (c: number, u: number) => (c && u ? `${cad(c)} + ${usd(u)}` : u ? usd(u) : cad(c));

const longDay = (d: string) => `${dayText(d)}, ${d.slice(0, 4)}`;

// Compact, sourced facts for "Ask about my money": Claude only, read-only, from Nakul's own files on this Mac.
export function moneyFacts(db: Database, spaceId: string, now: number): string[] {
  const v = moneyView(db, spaceId, now);
  const bank = counted(txs(db, spaceId, "bank"));
  const rules = listRules(db, spaceId);
  const out = ["Money facts (from files the user imported on this Mac; amounts in CAD unless marked US$):"];
  if (!v.counts.wealthsimple) out.push("No Wealthsimple activity imported.");
  for (const y of v.ws.slice(0, 3)) {
    out.push(
      `Wealthsimple ${y.year}: deposits ${cad(y.deposits)} (TFSA ${cad(y.tfsaDeposits)}), withdrawals ${cad(y.withdrawals)}, dividends ${both(y.dividends, y.usd.dividends)}, fees ${cad(y.fees)}, buys ${both(y.buys, y.usd.buys)}, sells ${both(y.sells, y.usd.sells)}.`,
    );
  }
  const year = Number(etDate(now).slice(0, 4));
  const room = roomStatus(db, year);
  const logged = listEntries(db, year);
  if (room.roomJan1 != null || logged.length) {
    const put = logged.filter((e) => e.kind === "contribution").reduce((s, e) => s + e.amount, 0);
    out.push(`TFSA ${year} (the user's own entries): room on Jan 1 ${room.roomJan1 != null ? cad(room.roomJan1) : "not set"}, contributions logged ${cad(put)}.`);
  }
  const n = v.counts.bank;
  if (!n) out.push("No bank or card transactions imported.");
  else {
    out.push(`Bank and card: ${n} ${n === 1 ? "transaction" : "transactions"} from ${longDay(v.range!.from)} to ${longDay(v.range!.to)} in ${v.accounts.map(maskNumbers).join(" and ")}.`);
    const all = txs(db, spaceId, "bank");
    for (const m of v.months.slice(0, 3)) {
      const s = spendingIn(bank, m, rules);
      const moved = movedIn(all, m);
      const top = s.spending.slice(0, 5).map((c) => `${c.category} ${cad(c.amount)}`).join(", ");
      const refunds = s.refunds.count ? `; refunds ${cad(s.refunds.total)}` : "";
      const between = moved.count ? `; moved between their accounts ${cad(moved.total)}` : "";
      out.push(`- ${monthYear(m)}: spent ${cad(s.spent)}${top ? ` (${top})` : ""}; money in ${cad(s.income)}${refunds}${between}.`);
    }
    const recent = bank.filter((t) => t.amount < 0 && days(t.date, v.range!.to) <= 90);
    const merchants = new Map<string, number>();
    for (const t of recent) merchants.set(t.merchant, (merchants.get(t.merchant) ?? 0) - t.amount);
    const top = [...merchants.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (top.length) out.push(`Top places, last 90 days: ${top.map(([m, a]) => `${m} ${cad(a)}`).join(", ")}.`);
    if (v.recurring.length) out.push(`Recurring charges: ${v.recurring.map((r) => `${r.merchant} ${cad(r.amount)} monthly (${r.count} times, last ${dayText(r.last)})`).join("; ")}.`);
    if (v.unusual.length) out.push(`Unusual: ${v.unusual.slice(0, 5).map((u) => `${dayText(u.date)} ${u.merchant} ${cad(u.amount)}: ${u.reason}`).join("; ")}`);
  }
  return out;
}

export function requestMoneyAsk(db: Database, spaceId: string, question: string): Task {
  const q = question.trim();
  if (!q) throw new Error("Type a question, like How much did I get in dividends this year?");
  if (q.length > MONEY_ASK_MAX) throw new Error("Keep the question under 500 characters.");
  // A card number typed into the question would go to Claude as is.
  if (!isMasked(q)) throw new Error("Leave card and account numbers out of the question.");
  if (moneyBusy(db, spaceId)) throw new Error("Claude is already looking at your money.");
  return createTask(db, { spaceId, title: "Ask Claude about my money", detail: q, agent: "claude", weight: "light", allowOnBattery: true, purpose: "money" });
}

// "Explain my month": the same read-only Claude ask, given only the recap Atrium worked out for that month.
export const RECAP_SUBJECT = "recap:";
export function requestExplain(db: Database, spaceId: string, month: string, now: number): Task {
  if (!/^\d{4}-\d{2}$/.test(month) || !recap(db, spaceId, now, month)) throw new Error("There's nothing imported for that month yet.");
  if (moneyBusy(db, spaceId)) throw new Error("Claude is already looking at your money.");
  return createTask(db, {
    spaceId,
    title: "Explain my month",
    detail: `Explain my month: ${monthYear(month)}`,
    agent: "claude",
    weight: "light",
    allowOnBattery: true,
    purpose: "money",
    subject: `${RECAP_SUBJECT}${month}`,
  });
}

// The facts and the brief for an Explain my month task; null for an ordinary money question.
export function explainContext(db: Database, task: Pick<Task, "spaceId" | "subject">, now: number): string[] | null {
  if (!task.subject?.startsWith(RECAP_SUBJECT)) return null;
  const r = recap(db, task.spaceId, now, task.subject.slice(RECAP_SUBJECT.length));
  if (!r) return ["There's no recap for that month anymore. Say so in one sentence."];
  return [
    ...recapFacts(r),
    "Rephrase these facts for the user in at most 120 words of plain, calm prose: where their money went this month compared with last month. Use only the numbers above, exactly as written; don't add, total or estimate any others. If the month is incomplete, say so first. No headings, no advice.",
  ];
}
