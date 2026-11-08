import type { Database } from "bun:sqlite";
import { getSpace } from "../engine/spaces";
import { AV_RESERVE, dailyBudget, dataBudget } from "../engine/markets/budget";
import { etDate } from "../engine/markets/calendar";
import { adjustedCloses, closes } from "../engine/markets/closes";
import { AV_DAILY_LIMIT, currentQuote } from "../engine/markets/data";
import { crossCheck, edgarStatus, setEdgarContact, type EdgarStatus } from "../engine/markets/edgar";
import { estimateFor, ESTIMATED } from "../engine/markets/estimate";
import { recentNews, saveEarnings, upcomingEarnings } from "../engine/markets/events";
import { fileSource } from "../engine/markets/funds/lookthrough";
import { refreshFund } from "../engine/markets/funds/refresh";
import { FUND_SOURCES, fileFundFor, isFund } from "../engine/markets/funds/sources";
import { fundError, loadFundFile } from "../engine/markets/funds/store";
import { FundFileError } from "../engine/markets/funds/types";
import { fxOn, latestFx } from "../engine/markets/fx";
import { listHoldings } from "../engine/markets/holdings";
import { listIdeas, setIdea, type Stage } from "../engine/markets/ideas";
import { instrumentKey, parseInstrumentKey } from "../engine/markets/instrument";
import { currencyOfKey } from "../engine/markets/labels";
import { getMeta } from "../engine/markets/meta";
import { performance, type Period } from "../engine/markets/performance";
import { healthFor, lookThroughFor, positionsFor } from "../engine/markets/portfolio";
import { redact } from "../engine/markets/redact";
import { getNotes, latestWriteups, requestThesisDraft, saveNotes } from "../engine/markets/research";
import { screenRows } from "../engine/markets/screener";
import { setupInvesting } from "../engine/markets/setup";
import { quoteSourced } from "../engine/markets/sourced";
import { addEntry, incomeTtm, listEntries, removeEntry, roomStatus, setRoom, tfsaOf, ttmDividends, withholdingNote } from "../engine/markets/tfsa";
import { listWatchlist } from "../engine/markets/watchlist";
import { getSetting, setSetting } from "../engine/settings";
import type { JobStatus } from "../engine/markets/jobs";
import { HttpError, json, readBody } from "./http";
import type { MarketsDeps } from "./markets";

export type HealthView = ReturnType<typeof healthView>;
export type ResearchView = ReturnType<typeof researchView>;
export type BudgetView = {
  sources: ReturnType<typeof dataBudget>;
  alphaVantage: { plan: string[]; deferred: string[]; reserve: number; used: number };
  jobs: JobStatus[];
  edgar: EdgarStatus;
};
export type TfsaView = ReturnType<typeof roomStatus> & { entries: ReturnType<typeof listEntries> };

const BAD_SYMBOL = "Type a symbol like AAPL or SHOP.TO.";
const PERIODS: Period[] = ["1M", "3M", "YTD", "1Y"];
const YEAR_MS = 365 * 86_400_000;

// Engine validation throws plain sentences written for Nakul; here they become 400s.
function check<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, (e as Error).message);
  }
}
const keyOf = (raw: string): string => {
  const i = parseInstrumentKey(decodeURIComponent(raw).trim().toUpperCase());
  if (!i) throw new HttpError(400, BAD_SYMBOL);
  return instrumentKey(i);
};

export async function investingRoute(db: Database, m: MarketsDeps, req: Request, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/investing/")) return null;
  try {
    return await route(db, m, req, url);
  } catch (e) {
    if (e instanceof HttpError) throw new HttpError(e.status, redact(e.message, m.data.secrets()));
    console.error(`Investing error: ${redact(e instanceof Error ? (e.stack ?? e.message) : String(e), m.data.secrets())}`);
    throw new HttpError(500, "Something went wrong in Atrium's investing code. Check the engine log.");
  }
}

// Every GET reads SQLite only: no provider calls and no Keychain reads. The one route that fetches is a fund refresh.
async function route(db: Database, m: MarketsDeps, req: Request, url: URL): Promise<Response | null> {
  const now = (m.now ?? Date.now)();
  const method = req.method;
  const path = url.pathname.slice("/api/investing".length);
  const hit = (verb: string, pattern: RegExp) => (method === verb ? path.match(pattern) : null);

  if (hit("GET", /^\/budget$/)) {
    const read = (k: string) => JSON.parse(getSetting(db, k) ?? "[]") as string[];
    const used = AV_DAILY_LIMIT - dailyBudget(db, "alphavantage", AV_DAILY_LIMIT, () => now).remaining();
    return json({
      sources: dataBudget(db, now),
      alphaVantage: { plan: read("markets.av.plan"), deferred: read("markets.av.deferred"), reserve: AV_RESERVE, used },
      jobs: m.jobs?.status() ?? [],
      edgar: edgarStatus(db, now),
    });
  }
  if (hit("PUT", /^\/edgar$/)) {
    const b = await readBody(req);
    if (b.on !== undefined && typeof b.on !== "boolean") throw new HttpError(400, "on must be true or false.");
    if (b.contact !== undefined) check(() => setEdgarContact(db, String(b.contact)));
    if (b.on !== undefined) setSetting(db, "markets.edgar", b.on ? "on" : "off");
    return json(edgarStatus(db, now));
  }
  if (hit("POST", /^\/setup$/)) return json(setupInvesting(db));
  if (hit("GET", /^\/tfsa$/)) {
    const year = Number(url.searchParams.get("year") ?? etDate(now).slice(0, 4));
    if (!Number.isInteger(year)) throw new HttpError(400, "Pick a year like 2026.");
    return json({ ...roomStatus(db, year), entries: listEntries(db, year) });
  }
  if (hit("PUT", /^\/tfsa\/room$/)) {
    const b = await readBody(req);
    check(() => setRoom(db, Number(b.year), Number(b.roomJan1)));
    return json(roomStatus(db, Number(b.year)));
  }
  if (hit("POST", /^\/tfsa\/entries$/)) {
    const b = await readBody(req);
    const id = check(() => addEntry(db, { date: String(b.date ?? ""), kind: b.kind as "contribution", amount: Number(b.amount), note: typeof b.note === "string" ? b.note : "" }));
    return json({ id });
  }
  const delEntry = hit("DELETE", /^\/tfsa\/entries\/([^/]+)$/);
  if (delEntry) {
    removeEntry(db, decodeURIComponent(delEntry[1]!));
    return json({ ok: true });
  }

  const sm = path.match(/^\/([^/]+)(\/.*)?$/);
  if (!sm) return null;
  const spaceId = decodeURIComponent(sm[1]!);
  const space = getSpace(db, spaceId);
  if (!space || space.kind !== "markets") throw new HttpError(404, "No such markets space.");
  const rest = sm[2] ?? "";
  const sub = (verb: string, pattern: RegExp) => (method === verb ? rest.match(pattern) : null);

  if (sub("GET", /^\/health$/)) return json(healthView(db, m, spaceId, now));
  const research = sub("GET", /^\/research\/([^/]+)$/);
  if (research) return json(researchView(db, m, spaceId, keyOf(research[1]!), now));
  const notes = sub("PUT", /^\/research\/([^/]+)\/notes$/);
  if (notes) {
    const key = keyOf(notes[1]!);
    const b = await readBody(req);
    const str = (v: unknown) => (v === undefined ? undefined : typeof v === "string" ? v : "");
    check(() => saveNotes(db, spaceId, key, { thesis: str(b.thesis), notes: str(b.notes) }));
    return json(getNotes(db, spaceId, key));
  }
  const draft = sub("POST", /^\/research\/([^/]+)\/thesis-draft$/);
  if (draft) {
    const t = check(() => requestThesisDraft(db, spaceId, keyOf(draft[1]!)));
    m.kick();
    return json({ taskId: t.id });
  }
  const earn = sub("POST", /^\/research\/([^/]+)\/earnings$/);
  if (earn) {
    const key = keyOf(earn[1]!);
    const b = await readBody(req);
    if (typeof b.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(b.date) || Number.isNaN(Date.parse(b.date))) throw new HttpError(400, "Use a date like 2026-12-10.");
    if (b.hour !== undefined && b.hour !== "bmo" && b.hour !== "amc") throw new HttpError(400, "hour must be bmo (before open) or amc (after close).");
    saveEarnings(db, [{ key, date: b.date, hour: (b.hour as string | undefined) ?? null, epsEstimate: null }], "you");
    return json({ ok: true });
  }
  if (sub("GET", /^\/ideas$/)) return json(listIdeas(db, spaceId));
  const idea = sub("PUT", /^\/ideas\/([^/]+)$/);
  if (idea) {
    const b = await readBody(req);
    const patch = { stage: b.stage as Stage | undefined, note: typeof b.note === "string" ? b.note : undefined };
    return json(check(() => setIdea(db, spaceId, keyOf(idea[1]!), patch)));
  }
  if (sub("GET", /^\/screener$/)) return json(screenRows(db, m.data, spaceId, now));
  if (sub("GET", /^\/digests$/)) return json(latestWriteups(db, spaceId, { kind: "digest", limit: 7 }));
  const refresh = sub("POST", /^\/funds\/([^/]+)\/refresh$/);
  if (refresh) {
    const key = keyOf(refresh[1]!);
    if (!isFund(key)) throw new HttpError(400, `Atrium has no holdings source for ${key}.`);
    try {
      const f = await refreshFund(db, key, { fetch: m.fetch, now: () => now });
      return json({ asOf: f.asOf, source: f.source });
    } catch (e) {
      throw new HttpError(422, e instanceof FundFileError ? e.message : "Atrium couldn't refresh that holdings file.");
    }
  }
  return null;
}

function usExposure(db: Database, key: string): number {
  const lt = lookThroughFor(db, key);
  if (!lt) return key.endsWith(".TO") ? 0 : 1;
  return lt.exposures.filter((e) => e.country === "United States").reduce((a, e) => a + e.weight, 0);
}

// Only called for a TFSA holding, so the account passed on is just a TFSA label.
function withholdingFor(db: Database, key: string, now: number): string | null {
  const ccy = currencyOfKey(key);
  return withholdingNote({ key, account: "TFSA", listingCcy: ccy, ttmDividend: ttmDividends(db, key, now), usExposure: ccy === "CAD" ? usExposure(db, key) : 1 });
}

function healthView(db: Database, m: MarketsDeps, spaceId: string, now: number) {
  const positions = positionsFor(db, m.data, spaceId, now);
  const fx = latestFx(db);
  const today = etDate(now);
  const health = healthFor(db, m.data, spaceId, now);
  const holdings = positions.map((p) => ({
    key: p.key,
    quantity: p.quantity,
    listingCcy: p.listingCcy,
    valueCad: health.pnl.find((x) => x.key === p.key && x.account === p.account)?.valueCad ?? null,
  }));
  const withholding: Record<string, string> = {};
  for (const p of positions) {
    const note = tfsaOf(p) ? withholdingFor(db, p.key, now) : null;
    if (note) withholding[p.key] = note;
  }
  const funds = [...new Set(positions.map((p) => p.key).filter(isFund))].map((key) => {
    const file = loadFundFile(db, fileFundFor(key));
    const src = FUND_SOURCES[key];
    return {
      key,
      asOf: file?.asOf ?? null,
      source: file ? fileSource(file).source : null,
      lastError: file?.lastError ?? fundError(db, fileFundFor(key)),
      note: src?.kind === "alias" ? src.note : (file?.note ?? null),
    };
  });
  return {
    health,
    performance: PERIODS.map((p) => performance({ holdings, closes: (k, f) => closes(db, k, f), fxOn: (d) => fxOn(db, d), today }, p)),
    income: incomeTtm(db, positions, fx, now),
    withholding,
    fx,
    funds,
  };
}

function researchView(db: Database, m: MarketsDeps, spaceId: string, key: string, now: number) {
  const i = parseInstrumentKey(key)!;
  const meta = getMeta(db, [key]).get(key) ?? null;
  const q = currentQuote(db, m.data, i);
  const proxy = ESTIMATED[key] ? currentQuote(db, m.data, parseInstrumentKey(ESTIMATED[key]!.proxy)!) : null;
  const name = [...listWatchlist(db, spaceId), ...listHoldings(db, spaceId)].find((x) => x.key === key && x.name)?.name ?? meta?.name ?? key;
  const edgarEps = (db.query("SELECT edgar_eps_ttm FROM instrument_meta WHERE key = ?").get(key) as { edgar_eps_ttm: number | null } | null)?.edgar_eps_ttm ?? null;
  const held = listHoldings(db, spaceId).find((h) => h.key === key);
  const drafting = !!db
    .query("SELECT 1 FROM tasks WHERE space_id = ? AND purpose = 'thesis_draft' AND subject = ? AND status IN ('queued','running') LIMIT 1")
    .get(spaceId, key);
  return {
    key,
    name,
    meta,
    price: q ? quoteSourced(q, now) : null,
    estimate: estimateFor(db, key, proxy, now),
    closes: adjustedCloses(closes(db, key, etDate(now - YEAR_MS))),
    earnings: upcomingEarnings(db, [key], etDate(now), 120),
    dividends: (db.query("SELECT ex_date, amount FROM market_dividends WHERE key = ? ORDER BY ex_date DESC LIMIT 8").all(key) as { ex_date: string; amount: number }[]).map((d) => ({
      exDate: d.ex_date,
      amount: d.amount,
    })),
    news: recentNews(db, [key], 0, 10),
    notes: getNotes(db, spaceId, key),
    writeups: latestWriteups(db, spaceId, { key, limit: 10 }),
    edgar: q && edgarEps !== null ? crossCheck(meta?.pe ?? null, q.price, edgarEps) : null,
    lookThrough: isFund(key) ? lookThroughFor(db, key) : null,
    withholding: held && tfsaOf(held) ? withholdingFor(db, key, now) : null,
    drafting,
  };
}
