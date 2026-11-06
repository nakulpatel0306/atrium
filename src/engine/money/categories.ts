import type { Database } from "bun:sqlite";
import { bus } from "../events";
import { getSetting } from "../settings";

// Spending categories come from a short list of words matched against a transaction's description, on this Mac.
// Nakul can edit the list; the first rule that matches wins, and anything unmatched is Other.
export type Rule = { match: string; category: string };

export const NOT_SPENDING = new Set(["Transfers", "Income"]);
export const MAX_RULES = 200;

export const DEFAULT_RULES: Rule[] = [
  ...["payroll", "salary", "direct deposit"].map((match) => ({ match, category: "Income" })),
  ...["landlord", "rent"].map((match) => ({ match, category: "Housing" })),
  ...["uber eats", "doordash", "skip the dishes", "starbucks", "tim hortons", "mcdonald", "restaurant", "cafe"].map((match) => ({ match, category: "Dining" })),
  ...["loblaws", "metro", "sobeys", "no frills", "food basics", "freshco", "costco", "whole foods", "farm boy", "longo"].map((match) => ({ match, category: "Groceries" })),
  ...["netflix", "spotify", "adobe", "disney", "youtube", "apple com bill", "crave", "prime video", "openai", "anthropic", "icloud"].map((match) => ({ match, category: "Subscriptions" })),
  ...["presto", "uber", "lyft", "shell", "petro", "esso", "go transit", "ttc"].map((match) => ({ match, category: "Transport" })),
  ...["rogers", "bell", "telus", "fido", "koodo", "hydro", "enbridge", "insurance"].map((match) => ({ match, category: "Bills" })),
  ...["amazon", "amzn", "best buy", "ikea", "walmart", "winners"].map((match) => ({ match, category: "Shopping" })),
  ...["e transfer", "e trf", "interac", "payment thank you", "payment from", "transfer"].map((match) => ({ match, category: "Transfers" })),
];

const words = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;

export function categorize(description: string, rules: Rule[]): string {
  const text = words(description);
  return rules.find((r) => text.includes(words(r.match)))?.category ?? "Other";
}

// "LOBLAWS #1234" → "Loblaws", "UBER* EATS" → "Uber Eats": the first two words without digits, in title case.
export function merchantOf(description: string): string {
  const tokens = description
    .replace(/\*/g, " ")
    .split(/\s+/)
    .filter((t) => t && !/\d/.test(t) && /[a-z]/i.test(t));
  const name = tokens.slice(0, 2).join(" ");
  return name ? name.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase()) : description.trim().slice(0, 40);
}

const seededKey = (spaceId: string) => `money.rules.${spaceId}`;

// Seeded once with the defaults; after that the list is whatever Nakul left, even empty.
export function listRules(db: Database, spaceId: string): Rule[] {
  const raw = getSetting(db, seededKey(spaceId));
  return raw ? (JSON.parse(raw) as Rule[]) : DEFAULT_RULES;
}

export function setRules(db: Database, spaceId: string, rules: Rule[]): Rule[] {
  if (!Array.isArray(rules) || rules.length > MAX_RULES) throw new Error(`Keep it to ${MAX_RULES} rules or fewer.`);
  const clean = rules.map((r) => ({ match: String(r?.match ?? "").trim(), category: String(r?.category ?? "").trim() }));
  if (clean.some((r) => !r.match || !r.category)) throw new Error("Each rule needs words to match and a category.");
  if (clean.some((r) => r.match.length > 60 || r.category.length > 30)) throw new Error("Keep matches under 60 characters and categories under 30.");
  db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(seededKey(spaceId), JSON.stringify(clean));
  bus.emit({ type: "changed" });
  return clean;
}
