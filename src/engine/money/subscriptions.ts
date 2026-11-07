import { categorize, NOT_SPENDING, type Rule } from "./categories";
import type { Tx } from "./rows";

// Every charge that comes back on a schedule: subscriptions, rent, the phone bill. Facts only, no cancel buttons.
export type SubFlag = "price-up" | "forgotten" | "new";
export type Subscription = {
  merchant: string;
  cadence: "monthly" | "yearly";
  amount: number;
  perMonth: number;
  count: number;
  last: string;
  next: string;
  flags: SubFlag[];
  // The amount before it went up, when it did.
  was: number | null;
  // Rent, a bill, or over CA$200 a month: shown under Bills.
  bill: boolean;
};
export type Group = { list: Subscription[]; perMonth: number; perYear: number };
// Subscriptions, with rent, bills and anything over CA$200 a month in a group of their own so they don't swamp it.
export type SubscriptionList = Group & { bills: Group };

const DAY_MS = 86_400_000;
const SAME = 0.02;
const FORGOTTEN_QUIET_DAYS = 90;
const STILL_CHARGING_DAYS = 40;
const round2 = (n: number) => Math.round(n * 100) / 100;
const days = (a: string, b: string) => (Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY_MS;
const addMonths = (date: string, n: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};
const monthly = (g: number) => (g >= 25 && g <= 35) || (g >= 55 && g <= 65);
const yearly = (g: number) => g >= 350 && g <= 380;
// Rent and bills are expected to be the only charge from their payee, and they go in Bills.
const BILL_CATEGORIES = new Set(["Housing", "Bills"]);
const BILL_OVER = 200;
// "Maybe forgotten" only for something small that has run a while: under CA$50 a month, first charged over 3 months ago.
const FORGOTTEN_UNDER = 50;
const FORGOTTEN_AGE_DAYS = 90;
const firstWord = (merchant: string) => merchant.toLowerCase().split(/[\s.*/]+/)[0] ?? "";

// Runs of about the same amount, in date order: [16.49, 16.49, 18.99] is two runs.
function runs(amounts: number[]): number[][] {
  const out: number[][] = [];
  for (const a of amounts) {
    const run = out.at(-1);
    if (run && Math.abs(a - run[0]!) <= run[0]! * SAME) run.push(a);
    else out.push([a]);
  }
  return out;
}

export function subscriptions(rows: Tx[], rules: Rule[]): SubscriptionList {
  // A payment to a card is many charges at once, not one service, even when it counts as spending.
  const spend = rows.filter((t) => t.amount < 0 && !t.flow && !NOT_SPENDING.has(categorize(t.description, rules)));
  const latest = rows.at(-1)?.date;
  if (!latest) return { list: [], perMonth: 0, perYear: 0, bills: { list: [], perMonth: 0, perYear: 0 } };
  const latestMonth = latest.slice(0, 7);
  const byMerchant = new Map<string, Tx[]>();
  for (const t of spend) {
    const list = byMerchant.get(t.merchant);
    if (list) list.push(t);
    else byMerchant.set(t.merchant, [t]);
  }
  // Rows from the last 90 days by their merchant's first word, built once.
  const recentByWord = new Map<string, { id: string; date: string }[]>();
  for (const t of rows) {
    if (days(t.date, latest) > FORGOTTEN_QUIET_DAYS) continue;
    const word = firstWord(t.merchant);
    const list = recentByWord.get(word);
    if (list) list.push(t);
    else recentByWord.set(word, [t]);
  }

  const list: Subscription[] = [];
  for (const [merchant, charges] of byMerchant) {
    const amounts = charges.map((t) => -t.amount);
    const gaps = charges.slice(1).map((t, i) => days(charges[i]!.date, t.date));
    const category = categorize(charges[0]!.description, rules);
    const isSubCategory = category === "Subscriptions";
    const steps = runs(amounts);
    // One step in price is allowed, after the old price held for at least two charges.
    const steady = steps.length === 1 || (steps.length === 2 && steps[0]!.length >= 2);
    const last = charges.at(-1)!;
    let cadence: Subscription["cadence"] | null = null;
    if (steady && gaps.length && gaps.every(monthly) && (charges.length >= 3 || isSubCategory)) cadence = "monthly";
    else if (steady && gaps.length && gaps.every(yearly)) cadence = "yearly";
    else if (charges.length === 1 && isSubCategory && last.date.startsWith(latestMonth)) cadence = "monthly";
    if (!cadence) continue;
    // A schedule that stopped is a cancelled one.
    if (days(last.date, latest) > (cadence === "monthly" ? 45 : 400)) continue;
    const amount = round2(-last.amount);
    const flags: SubFlag[] = [];
    let was: number | null = null;
    const before = steps.length === 2 ? steps[0]! : null;
    if (before && amount > before[0]! && steps[1]!.length <= 3) {
      flags.push("price-up");
      was = round2(before.at(-1)!);
    }
    const own = new Set(charges.map((t) => t.id));
    const word = firstWord(merchant);
    const elsewhere = (recentByWord.get(word) ?? []).some((t) => !own.has(t.id));
    const perMonth = round2(cadence === "monthly" ? amount : amount / 12);
    const bill = BILL_CATEGORIES.has(category) || perMonth > BILL_OVER;
    const old = days(charges[0]!.date, latest) > FORGOTTEN_AGE_DAYS;
    if (!elsewhere && !bill && perMonth < FORGOTTEN_UNDER && old && charges.length >= 3 && days(last.date, latest) <= STILL_CHARGING_DAYS) flags.push("forgotten");
    if (charges[0]!.date.startsWith(latestMonth)) flags.push("new");
    list.push({
      merchant,
      cadence,
      amount,
      perMonth,
      bill,
      count: charges.length,
      last: last.date,
      next: addMonths(last.date, cadence === "monthly" ? 1 : 12),
      flags,
      was,
    });
  }
  list.sort((a, b) => b.perMonth - a.perMonth);
  const group = (xs: Subscription[]): Group => ({
    list: xs,
    perMonth: round2(xs.reduce((s, x) => s + x.perMonth, 0)),
    perYear: round2(xs.reduce((s, x) => s + (x.cadence === "monthly" ? x.amount * 12 : x.amount), 0)),
  });
  return { ...group(list.filter((x) => !x.bill)), bills: group(list.filter((x) => x.bill)) };
}
