import type { Database } from "bun:sqlite";
import { getSpace } from "../engine/spaces";
import { listRules, setRules, type Rule } from "../engine/money/categories";
import { importMoney, previewMoney, type DateOrder, type MoneyMap, type Signs } from "../engine/money/import";
import { moneySummary, moneyView, requestExplain, requestMoneyAsk, STARTERS } from "../engine/money/summary";
import { accountChoices, addAccount } from "../engine/money/accounts";
import { checkBudgets, listBudgets, setBudget } from "../engine/money/budgets";
import { dismissNudge } from "../engine/money/nudges";
import { importReminder } from "../engine/money/reminder";
import { markTransfer } from "../engine/money/transfers";
import { BUSY, changeImportAccount, findImport, GONE, moneyBusy, undoImport } from "../engine/money/imports";
import { redact } from "../engine/markets/redact";
import { HttpError, json, readBody } from "./http";
import type { MarketsDeps } from "./markets";

const MAX_CSV_BYTES = 2 * 1024 * 1024;
const TOO_BIG = "That file is over 2 MB; export a shorter date range.";
// The JSON around a 2 MB file (escaped quotes and newlines) can be larger than the file itself.
const BODY_LIMIT = { bytes: 2 * MAX_CSV_BYTES + 64 * 1024, message: TOO_BIG };
const PREVIEW_ROWS = 20;
const OWNED = /^\/api\/investing\/([^/]+)\/money(\/(?:preview|import|accounts|rules|ask|explain|transfer|budgets|nudges\/[^/]+\/dismiss))?$/;
const IMPORT = /^\/api\/money\/imports\/([^/]+)(\/account)?$/;

function check<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, (e as Error).message);
  }
}

function previewOf(b: Record<string, unknown>) {
  if (typeof b.csv !== "string" || !b.csv.trim()) throw new HttpError(400, "Pick a CSV file or paste its contents.");
  if (Buffer.byteLength(b.csv) > MAX_CSV_BYTES) throw new HttpError(413, TOO_BIG);
  const mapping =
    typeof b.mapping === "object" && b.mapping !== null
      ? (Object.fromEntries(Object.entries(b.mapping).filter(([, v]) => Number.isInteger(v) && (v as number) >= 0)) as MoneyMap)
      : undefined;
  const signs = b.signs === "positive-out" || b.signs === "negative-out" ? (b.signs as Signs) : undefined;
  const dates = b.dates === "mdy" || b.dates === "dmy" ? (b.dates as DateOrder) : undefined;
  const account = typeof b.account === "string" ? b.account : undefined;
  return previewMoney(b.csv, { mapping, signs, dates, account });
}

// Undo an import, or move its rows to another of his accounts. Neither runs while Claude is reading his money.
async function importRoute(db: Database, req: Request, id: string, account: boolean): Promise<Response | null> {
  if (!(req.method === "DELETE" && !account) && !(req.method === "POST" && account)) return null;
  const imp = findImport(db, id);
  if (!imp || getSpace(db, imp.space_id)?.kind !== "markets") throw new HttpError(404, GONE);
  if (moneyBusy(db, imp.space_id)) throw new HttpError(409, BUSY);
  if (!account) return json(check(() => undoImport(db, id)));
  const b = await readBody(req);
  return json(check(() => changeImportAccount(db, id, typeof b.account === "string" ? b.account : "")));
}

// The Money view: the user's own bank, card and Wealthsimple files, read and summarised on this Mac. Nothing here
// touches the network; only an ask sends compact facts to Claude.
export async function moneyRoute(db: Database, m: MarketsDeps, req: Request, url: URL): Promise<Response | null> {
  const owned = url.pathname.match(OWNED);
  const imported = url.pathname.match(IMPORT);
  if (!owned && !imported) return null;
  try {
    if (imported) return await importRoute(db, req, decodeURIComponent(imported[1]!), imported[2] === "/account");
    if (!owned) return null;
    const spaceId = decodeURIComponent(owned[1]!);
    const space = getSpace(db, spaceId);
    if (!space || space.kind !== "markets") throw new HttpError(404, "No such markets space.");
    const rest = owned[2] ?? "";
    const now = (m.now ?? Date.now)();
    if (req.method === "GET" && rest === "") {
      const view = moneyView(db, spaceId, now, url.searchParams.get("month") ?? undefined);
      // ?summary=1 is the terminal app's read: totals, budgets and the rest, never the transaction list.
      return json({ ...(url.searchParams.get("summary") === "1" ? moneySummary(view) : view), starters: STARTERS });
    }
    if (req.method === "POST" && rest === "/preview") {
      const p = previewOf(await readBody(req, BODY_LIMIT));
      return json({ ...p, rows: p.rows.slice(0, PREVIEW_ROWS).map(({ legacy: _legacy, ...r }) => r), total: p.rows.length, choices: accountChoices(db, spaceId, p.account) });
    }
    if (req.method === "POST" && rest === "/import") {
      const p = previewOf(await readBody(req, BODY_LIMIT));
      if (!p.rows.length) throw new HttpError(400, p.warnings[0] ?? "Nothing in that file could be imported.");
      const done = importMoney(db, spaceId, p);
      // A finished import may clear the monthly reminder or cross a budget.
      importReminder(db, spaceId, now);
      checkBudgets(db, spaceId, now);
      return json({ ...done, skipped: p.skipped.length });
    }
    if (req.method === "POST" && rest === "/accounts") {
      const b = await readBody(req);
      return json({ account: check(() => addAccount(db, spaceId, { name: String(b.name ?? ""), kind: String(b.kind ?? ""), institution: typeof b.institution === "string" ? b.institution : "" })) });
    }
    if (req.method === "GET" && rest === "/rules") return json(listRules(db, spaceId));
    if (req.method === "PUT" && rest === "/rules") {
      const b = await readBody(req);
      return json(check(() => setRules(db, spaceId, b.rules as Rule[])));
    }
    if (req.method === "POST" && rest === "/explain") {
      const b = await readBody(req);
      const task = check(() => requestExplain(db, spaceId, typeof b.month === "string" ? b.month : "", now));
      m.kick();
      return json({ taskId: task.id });
    }
    if (req.method === "POST" && rest === "/transfer") {
      const b = await readBody(req);
      if (typeof b.id !== "string" || !(b.transfer === true || b.transfer === false || b.transfer === null)) throw new HttpError(400, "Say whether it's a transfer: true, false or null.");
      check(() => markTransfer(db, spaceId, b.id as string, b.transfer as boolean | null));
      return json({ ok: true });
    }
    if (req.method === "PUT" && rest === "/budgets") {
      const b = await readBody(req);
      const limit = b.limit === null || b.limit === "" ? null : Number(b.limit);
      check(() => setBudget(db, spaceId, typeof b.category === "string" ? b.category : "", limit));
      checkBudgets(db, spaceId, now);
      return json(listBudgets(db, spaceId));
    }
    const dismiss = rest.match(/^\/nudges\/([^/]+)\/dismiss$/);
    if (req.method === "POST" && dismiss) {
      check(() => dismissNudge(db, decodeURIComponent(dismiss[1]!), now));
      return json({ ok: true });
    }
    if (req.method === "POST" && rest === "/ask") {
      const b = await readBody(req);
      const task = check(() => requestMoneyAsk(db, spaceId, typeof b.question === "string" ? b.question : ""));
      m.kick();
      return json({ taskId: task.id });
    }
    return null;
  } catch (e) {
    if (e instanceof HttpError) throw new HttpError(e.status, redact(e.message, m.data.secrets()));
    console.error(`Money error: ${redact(e instanceof Error ? (e.stack ?? e.message) : String(e), m.data.secrets())}`);
    throw new HttpError(500, "Something went wrong in Atrium's money code. Check the engine log.");
  }
}
