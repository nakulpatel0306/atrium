import { parseCsv } from "./csv";
import type { HoldingInput } from "./holdings";
import { instrumentFromWealthsimple, isSymbol, parseInstrumentKey, type Exchange } from "./instrument";

export type ImportField =
  | "account"
  | "symbol"
  | "exchange"
  | "mic"
  | "name"
  | "securityType"
  | "quantity"
  | "bookValue"
  | "bookCurrency"
  | "currency"
  | "activityType"
  | "activitySubType";
export type FieldMap = Partial<Record<ImportField, number>>;
export type ImportPreview = {
  format: "wealthsimple_holdings" | "wealthsimple_activity" | "unknown";
  headers: string[];
  mapping: FieldMap;
  rows: HoldingInput[];
  skipped: { line: number; reason: string }[];
  warnings: string[];
  accounts: string[];
  asOf: string | null;
  guessed: string[];
};

// Earlier aliases win when a file has several of them.
const ALIASES: Record<ImportField, string[]> = {
  account: ["account name", "account_type", "account", "account type"],
  symbol: ["symbol", "ticker"],
  exchange: ["exchange"],
  mic: ["mic"],
  name: ["name", "security name"],
  securityType: ["security type", "security_type"],
  quantity: ["quantity", "shares", "qty"],
  bookValue: ["book value (market)", "book value (cad)", "book value", "book_value"],
  bookCurrency: ["book value currency (market)", "book value currency (cad)"],
  currency: ["market price currency", "currency"],
  activityType: ["activity_type"],
  activitySubType: ["activity_sub_type"],
};

const COMPLETENESS = "Positions from an activity export are only right if the file covers every trade since each account opened.";
// Activity rows that don't change how many shares are held.
const CASH_ONLY = new Set(["trade", "dividend", "deposit", "withdrawal", "fee", "interest", "transfer"]);
const DEFAULT_ACCOUNT = "Imported";
const MAX_POSITIONS = 500;
const badSymbol = (s: string) => `"${s}" isn't a symbol Atrium can look up; add it by hand.`;

function detect(headers: string[]): FieldMap {
  const lower = headers.map((h) => h.trim().toLowerCase());
  const map: FieldMap = {};
  for (const [field, aliases] of Object.entries(ALIASES) as [ImportField, string[]][]) {
    for (const a of aliases) {
      const i = lower.indexOf(a);
      if (i >= 0) {
        map[field] = i;
        break;
      }
    }
  }
  return map;
}

// "$1,234.50" → 1234.5, "(20)" → −20; anything else that isn't a number is NaN.
function num(raw: string | undefined): number {
  let t = (raw ?? "").replace(/[$,\s]/g, "");
  let sign = 1;
  if (/^\(.*\)$/.test(t)) {
    sign = -1;
    t = t.slice(1, -1);
  }
  return t === "" ? NaN : sign * Number(t);
}

const currencyFor = (e: Exchange): "CAD" | "USD" => (e === "US" || e === "OTC" ? "USD" : "CAD");
const round = (n: number) => Math.round(n * 1e6) / 1e6;

export function previewImport(text: string, opts: { mapping?: FieldMap; exchangeOverrides?: Record<string, Exchange> } = {}): ImportPreview {
  const records = parseCsv(text);
  const headers = (records[0] ?? []).map((h) => h.trim());
  const detected = detect(headers);
  const lower = headers.map((h) => h.toLowerCase());
  const has = (f: ImportField) => detected[f] !== undefined;
  const format: ImportPreview["format"] =
    has("activityType") && has("quantity") && has("symbol")
      ? "wealthsimple_activity"
      : has("symbol") && has("quantity") && (lower.includes("market value") || has("bookValue"))
        ? "wealthsimple_holdings"
        : "unknown";
  const mapping: FieldMap = format === "unknown" ? { ...(opts.mapping ?? {}) } : { ...detected, ...(opts.mapping ?? {}) };
  const preview: ImportPreview = { format, headers, mapping, rows: [], skipped: [], warnings: [], accounts: [], asOf: null, guessed: [] };
  if (mapping.symbol === undefined || mapping.quantity === undefined) {
    preview.warnings.push("Pick which columns hold the symbol and quantity.");
    return preview;
  }
  const cell = (r: string[], f: ImportField) => (mapping[f] === undefined ? "" : (r[mapping[f]!] ?? "").trim());
  const accounts = new Set<string>();
  const data: { line: number; r: string[] }[] = [];
  for (let i = 1; i < records.length; i++) {
    const r = records[i]!;
    const first = (r[0] ?? "").trim();
    if (first.startsWith("As of ")) {
      preview.asOf = first.slice("As of ".length).trim();
      continue;
    }
    if (r.every((c) => c.trim() === "")) continue;
    data.push({ line: i + 1, r });
  }

  if (format === "wealthsimple_activity") {
    activity(preview, data, cell, opts.exchangeOverrides ?? {}, accounts);
  } else {
    for (const { line, r } of data) {
      const symbol = cell(r, "symbol").toUpperCase();
      if (!symbol) continue;
      const account = cell(r, "account") || DEFAULT_ACCOUNT;
      accounts.add(account);
      const type = cell(r, "securityType").toUpperCase();
      if (type.includes("OPTION")) {
        preview.skipped.push({ line, reason: "Options aren't tracked in v1." });
        continue;
      }
      if (type.includes("CRYPTO")) {
        preview.skipped.push({ line, reason: "Crypto isn't tracked in v1." });
        continue;
      }
      let inst: { symbol: string; exchange: Exchange } | null;
      if (mapping.exchange === undefined && mapping.mic === undefined) {
        inst = parseInstrumentKey(symbol);
        if (!inst) {
          preview.skipped.push({ line, reason: badSymbol(symbol) });
          continue;
        }
      } else if (!isSymbol(symbol)) {
        preview.skipped.push({ line, reason: badSymbol(symbol) });
        continue;
      }
      else {
        const e = opts.exchangeOverrides?.[symbol] ?? instrumentFromWealthsimple(cell(r, "exchange"), cell(r, "mic"));
        inst = e ? { symbol, exchange: e } : null;
      }
      if (!inst) {
        preview.skipped.push({ line, reason: `Unknown exchange "${cell(r, "exchange") || cell(r, "mic") || symbol}"; add it by hand.` });
        continue;
      }
      const quantity = num(cell(r, "quantity"));
      if (!Number.isFinite(quantity)) {
        preview.skipped.push({ line, reason: "Quantity isn't a number." });
        continue;
      }
      const cur = cell(r, "currency").toUpperCase() || currencyFor(inst.exchange);
      if (cur !== "CAD" && cur !== "USD") {
        preview.skipped.push({ line, reason: `Prices in ${cur} aren't supported; only CAD and USD.` });
        continue;
      }
      if (quantity <= 0) {
        preview.skipped.push({ line, reason: "Quantity must be more than zero." });
        continue;
      }
      const book = num(cell(r, "bookValue"));
      preview.rows.push({
        account,
        symbol: inst.symbol,
        exchange: inst.exchange,
        name: cell(r, "name"),
        quantity,
        bookValue: Number.isFinite(book) ? book : null,
        currency: cur,
      });
    }
  }
  preview.accounts = [...accounts];
  preview.skipped.sort((a, b) => a.line - b.line);
  if (preview.rows.length > MAX_POSITIONS) {
    preview.warnings.unshift(`That file has ${preview.rows.length} positions; Atrium imports at most ${MAX_POSITIONS} at a time. Export one account at a time.`);
    preview.rows = [];
  }
  return preview;
}

type Cell = (r: string[], f: ImportField) => string;

// Positions are rebuilt by replaying trades oldest first, at average cost: a sell takes its share of book value.
function activity(preview: ImportPreview, data: { line: number; r: string[] }[], cell: Cell, overrides: Record<string, Exchange>, accounts: Set<string>) {
  type Pos = { account: string; symbol: string; name: string; currency: string; qty: number; book: number };
  const positions = new Map<string, Pos>();
  const unapplied = new Map<string, number>();
  const dateIdx = preview.headers.findIndex((h) => h.toLowerCase() === "transaction_date");
  const net = preview.headers.findIndex((h) => h.toLowerCase() === "net_cash_amount");
  const ordered = [...data].sort((a, b) => (dateIdx < 0 ? 0 : (a.r[dateIdx] ?? "").localeCompare(b.r[dateIdx] ?? "")));
  for (const { line, r } of ordered) {
    const account = cell(r, "account") || DEFAULT_ACCOUNT;
    const symbol = cell(r, "symbol").toUpperCase();
    if (account) accounts.add(account);
    const type = cell(r, "activityType");
    const qty = Math.abs(num(cell(r, "quantity")));
    if (!symbol) continue;
    if (type.toLowerCase() !== "trade") {
      if (!CASH_ONLY.has(type.toLowerCase()) && qty > 0) unapplied.set(type, (unapplied.get(type) ?? 0) + 1);
      continue;
    }
    if (!isSymbol(symbol)) {
      preview.skipped.push({ line, reason: badSymbol(symbol) });
      continue;
    }
    if (!Number.isFinite(qty)) {
      preview.skipped.push({ line, reason: "Quantity isn't a number." });
      continue;
    }
    if (qty === 0) continue;
    const id = `${account}\u0000${symbol}`;
    const pos = positions.get(id) ?? { account, symbol, name: cell(r, "name"), currency: cell(r, "currency").toUpperCase(), qty: 0, book: 0 };
    positions.set(id, pos);
    const side = cell(r, "activitySubType").toUpperCase();
    if (side === "BUY") {
      pos.qty += qty;
      const cash = num(net >= 0 ? r[net] : "");
      if (Number.isFinite(cash)) pos.book += -cash;
    } else if (side === "SELL") {
      const before = pos.qty;
      pos.qty -= qty;
      pos.book = before > 0 && pos.qty > 0 ? pos.book * (pos.qty / before) : 0;
    }
  }
  for (const [type, n] of unapplied) preview.warnings.push(`${n} rows like "${type}" weren't applied (splits and reorganisations); check those positions.`);
  preview.warnings.push(COMPLETENESS);
  const guessed = new Set<string>();
  for (const p of positions.values()) {
    if (p.qty <= 1e-9) continue;
    const currency = p.currency === "USD" ? "USD" : "CAD";
    let exchange = overrides[p.symbol];
    if (!exchange) {
      exchange = currency === "USD" ? "US" : "TSX";
      guessed.add(p.symbol);
    }
    preview.rows.push({ account: p.account, symbol: p.symbol, exchange, name: p.name, quantity: round(p.qty), bookValue: Math.round(p.book * 100) / 100, currency });
  }
  preview.guessed = [...guessed];
}
