import type { Database } from "bun:sqlite";
import { getApproval } from "../engine/approvals";
import { createAlert, describeRule, listAlerts, removeAlert, setAlertStatus, type Alert, type AlertRule } from "../engine/markets/alerts";
import { backtest, type BacktestTemplate } from "../engine/markets/backtest";
import { dailyBudget, hourlyBudget } from "../engine/markets/budget";
import { lastCompletedSession } from "../engine/markets/calendar";
import { AV_DAILY_LIMIT, TIINGO_DAILY_LIMIT, TIINGO_HOURLY_LIMIT, currentQuote as current, type ChartRange, type DataStatus, type MarketData } from "../engine/markets/data";
import type { Feed, FeedStatus } from "../engine/markets/feed";
import { addHolding, listHoldings, removeHolding, replaceImported, updateHolding, type Holding } from "../engine/markets/holdings";
import { previewImport, type FieldMap } from "../engine/markets/import";
import { instrumentKey, parseInstrumentKey, type Exchange, type Instrument } from "../engine/markets/instrument";
import { isKeyShaped, KEY_ACCOUNTS, KeychainError, type Keychain } from "../engine/markets/keychain";
import { paperState, placePaperOrder, resetAccount, type PaperState } from "../engine/markets/paper";
import { alpacaProvider } from "../engine/markets/providers/alpaca";
import { alphaVantageProvider } from "../engine/markets/providers/alphavantage";
import { finnhubProvider } from "../engine/markets/providers/finnhub";
import { tiingoProvider, tiingoSymbols } from "../engine/markets/providers/tiingo";
import type { MarketProvider, Quote } from "../engine/markets/providers/types";
import { anyAdvanced, isAdvanced } from "../engine/markets/advanced";
import { redact } from "../engine/markets/redact";
import { estimateFor, ESTIMATED } from "../engine/markets/estimate";
import { latestFx } from "../engine/markets/fx";
import type { Jobs } from "../engine/markets/jobs";
import { portfolioDay, type PortfolioDay } from "../engine/markets/portfolio";
import type { Sourced } from "../engine/markets/sourced";
import { listStrategies, proposeStrategy, setStrategyPaused, type Strategy, type StrategyInput } from "../engine/markets/strategies";
import { addToWatchlist, listWatchlist, removeFromWatchlist, type WatchItem } from "../engine/markets/watchlist";
import { setSetting } from "../engine/settings";
import { getSpace } from "../engine/spaces";
import { HttpError, json, readBody } from "./http";

export type MarketsDeps = {
  data: MarketData;
  feed: Feed;
  keychain: Keychain;
  kick(): void;
  // The market clock (shifted in demo mode); paper fills and sessions use it.
  now?: () => number;
  // For the throwaway providers that check a key before it's saved; tests stub it.
  fetch?: typeof fetch;
  // The daily and weekly market jobs, for the data budget page.
  jobs?: Jobs;
};

type Priced<T> = T & { quote: Quote | null; missing: string | null };
export type MarketsView = {
  spaceId: string;
  watchlist: Priced<WatchItem>[];
  holdings: Priced<Holding>[];
  paper: PaperState;
  alerts: Alert[];
  strategies: Strategy[];
  feed: FeedStatus;
  data: DataStatus;
  // The portfolio's day across its holdings, cached prices only.
  portfolio: PortfolioDay | null;
  // Labelled display-only estimates (VFV.TO from SPY and USD/CAD), never used in totals or alerts.
  estimates: Record<string, Sourced>;
  // Bank of Canada USD/CAD for the CAD column; null until the fx job has run.
  fx: Sourced | null;
  // Whether this space shows Plan 7's Advanced tools.
  advanced: boolean;
};

const MAX_CSV_BYTES = 2 * 1024 * 1024;
const RANGES: ChartRange[] = ["5D", "1M", "3M", "6M", "1Y"];
const EXCHANGES: Exchange[] = ["US", "TSX", "TSXV", "NEO", "OTC"];
const PROVIDERS = ["finnhub", "demo"] as const;
const BAD_SYMBOL = "Type a symbol like AAPL or SHOP.TO.";
const SHAPE: Record<"alpaca" | "finnhub" | "alphavantage" | "tiingo", string> = {
  alpaca: "That doesn't look like an Alpaca key: keys are letters and numbers only.",
  finnhub: "That doesn't look like a Finnhub token: tokens are letters and numbers only.",
  alphavantage: "That doesn't look like an Alpha Vantage key: keys are letters and numbers only.",
  tiingo: "That doesn't look like a Tiingo token: tokens are letters and numbers only.",
};

// Per instrument, the last session close the view already tried to refresh for, so a dashboard that refetches on
// every change doesn't refetch prices (or spend Alpha Vantage's 25 a day) each time. Keyed by source too, so
// switching providers refreshes again.
const refreshed = new WeakMap<MarketData, Map<string, number>>();

// Validation in the engine throws plain Errors written for Nakul; here they become 400s.
function check<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, (e as Error).message);
  }
}

const symbolOf = (v: unknown): Instrument => {
  const i = typeof v === "string" ? parseInstrumentKey(v) : null;
  if (!i) throw new HttpError(400, BAD_SYMBOL);
  return i;
};
const numberOf = (v: unknown, field: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new HttpError(400, `${field} must be a number.`);
  return v;
};
const currencyOf = (v: unknown): "CAD" | "USD" => {
  if (v !== "CAD" && v !== "USD") throw new HttpError(400, "Currency must be CAD or USD.");
  return v;
};
const rangeOf = (v: unknown): ChartRange => {
  if (!RANGES.includes(v as ChartRange)) throw new HttpError(400, "Range must be 5D, 1M, 3M, 6M or 1Y.");
  return v as ChartRange;
};

function templateOf(v: unknown): BacktestTemplate {
  const t = v as Record<string, unknown> | null;
  const int = (x: unknown, lo: number, hi: number) => Number.isInteger(x) && (x as number) >= lo && (x as number) <= hi;
  if (t?.kind === "buy_hold") return { kind: "buy_hold" };
  if (t?.kind === "sma_cross" && int(t.fast, 2, 200) && int(t.slow, 2, 200) && (t.fast as number) < (t.slow as number)) {
    return { kind: "sma_cross", fast: t.fast as number, slow: t.slow as number };
  }
  if (t?.kind === "rsi_revert" && int(t.period, 2, 200) && int(t.buyBelow, 1, 99) && int(t.sellAbove, 1, 99)) {
    return { kind: "rsi_revert", period: t.period as number, buyBelow: t.buyBelow as number, sellAbove: t.sellAbove as number };
  }
  throw new HttpError(400, "Pick a backtest: SMA crossover (fast below slow), RSI reversion, or buy and hold.");
}

function importOpts(b: Record<string, unknown>): { csv: string; mapping?: FieldMap; exchangeOverrides?: Record<string, Exchange> } {
  if (typeof b.csv !== "string" || !b.csv.trim()) throw new HttpError(400, "Pick a CSV file or paste its contents.");
  if (Buffer.byteLength(b.csv) > MAX_CSV_BYTES) throw new HttpError(413, "That file is over 2 MB; export one account at a time.");
  let mapping: FieldMap | undefined;
  if (b.mapping !== undefined) {
    if (typeof b.mapping !== "object" || b.mapping === null) throw new HttpError(400, "mapping is not valid.");
    mapping = Object.fromEntries(Object.entries(b.mapping).filter(([, v]) => Number.isInteger(v) && (v as number) >= 0)) as FieldMap;
  }
  let exchangeOverrides: Record<string, Exchange> | undefined;
  if (b.exchangeOverrides !== undefined) {
    if (typeof b.exchangeOverrides !== "object" || b.exchangeOverrides === null) throw new HttpError(400, "exchangeOverrides is not valid.");
    exchangeOverrides = Object.fromEntries(Object.entries(b.exchangeOverrides).filter(([, v]) => EXCHANGES.includes(v as Exchange))) as Record<string, Exchange>;
  }
  return { csv: b.csv, mapping, exchangeOverrides };
}

export async function marketsRoute(db: Database, m: MarketsDeps, req: Request, url: URL): Promise<Response | null> {
  try {
    return await route(db, m, req, url);
  } catch (e) {
    if (e instanceof HttpError) throw new HttpError(e.status, redact(e.message, m.data.secrets()));
    // Anything unexpected is logged and answered without its text, which could hold a provider's echo.
    console.error(`Markets error: ${redact(e instanceof Error ? (e.stack ?? e.message) : String(e), m.data.secrets())}`);
    throw new HttpError(500, "Something went wrong in Atrium's markets code. Check the engine log.");
  }
}

async function route(db: Database, m: MarketsDeps, req: Request, url: URL): Promise<Response | null> {
  const { pathname } = url;
  if (!pathname.startsWith("/api/markets") && !pathname.startsWith("/api/settings/market-data")) return null;
  const now = m.now ?? Date.now;
  const method = req.method;
  const hit = (verb: string, pattern: RegExp) => (method === verb ? pathname.match(pattern) : null);

  if (hit("GET", /^\/api\/settings\/market-data$/)) {
    await m.data.refreshKeys();
    // The data budget is an Advanced tool; Settings shows it only while some space has Advanced on.
    return json({ data: await m.data.status(), feed: m.feed.status(), advanced: anyAdvanced(db) });
  }
  if (hit("PUT", /^\/api\/settings\/market-data$/)) {
    const b = await readBody(req);
    if (b.provider === "alpaca") throw new HttpError(400, "Alpaca isn't used anymore. Pick Finnhub or Demo.");
    if (!PROVIDERS.includes(b.provider as (typeof PROVIDERS)[number])) throw new HttpError(400, "Pick Finnhub or Demo.");
    setSetting(db, "markets.provider", b.provider as string);
    await m.data.refreshKeys();
    await m.feed.reevaluate();
    return json({ data: await m.data.status(), feed: m.feed.status() });
  }
  if (hit("POST", /^\/api\/settings\/market-data\/keys$/)) return json(await saveKeys(db, m, await readBody(req), now));
  const delKey = hit("DELETE", /^\/api\/settings\/market-data\/keys\/(alpaca|finnhub|alphavantage|tiingo)$/);
  if (delKey) {
    const accounts = {
      alpaca: [KEY_ACCOUNTS.alpacaKeyId, KEY_ACCOUNTS.alpacaSecret],
      finnhub: [KEY_ACCOUNTS.finnhub],
      alphavantage: [KEY_ACCOUNTS.alphavantage],
      tiingo: [KEY_ACCOUNTS.tiingo],
    };
    try {
      for (const a of accounts[delKey[1] as keyof typeof accounts]) await m.keychain.remove(a);
    } catch (e) {
      if (e instanceof KeychainError) throw new HttpError(422, e.message);
      throw e;
    }
    await m.data.reload();
    await m.feed.reevaluate();
    return json({ ok: true, message: "Removed from your Mac's Keychain." });
  }
  if (hit("POST", /^\/api\/settings\/market-data\/test$/)) {
    await m.data.refreshKeys(true);
    const probe = async (i: Instrument) => {
      const reason = m.data.reasonFor(i);
      if (reason) return { ok: false, message: reason };
      const r = await m.data.quotes([i]);
      const q = r.quotes[0];
      if (!q) return { ok: false, message: r.missing[0]?.reason ?? "No price came back." };
      return { ok: true, message: `${m.data.providerFor(i)?.label ?? q.source} answered.`, sample: { key: q.key, price: q.price, at: q.at, freshness: q.freshness, source: q.source } };
    };
    // History is probed with one small Tiingo request: five days of SPY.
    const history = async () => {
      const t = m.data.tiingo?.();
      if (!t) return { ok: true, message: "Not needed. Atrium keeps its own daily closes from Finnhub prices." };
      try {
        await t.daily({ symbol: "SPY", exchange: "US" }, new Date(now() - 5 * 86_400_000).toISOString().slice(0, 10));
        return { ok: true, message: "Tiingo answered." };
      } catch (e) {
        return { ok: false, message: redact(e instanceof Error ? e.message : String(e), m.data.secrets()) };
      }
    };
    return json({ us: await probe({ symbol: "AAPL", exchange: "US" }), ca: await probe({ symbol: "SHOP", exchange: "TSX" }), history: await history() });
  }

  if (hit("GET", /^\/api\/markets\/bars$/)) {
    const i = symbolOf(url.searchParams.get("key"));
    return json(await m.data.bars(i, rangeOf(url.searchParams.get("range"))));
  }

  const sm = pathname.match(/^\/api\/markets\/([^/]+)(\/.*)?$/);
  if (!sm) return null;
  const spaceId = decodeURIComponent(sm[1]!);
  const space = getSpace(db, spaceId);
  if (!space || space.kind !== "markets") throw new HttpError(404, "No such markets space.");
  const rest = sm[2] ?? "";
  const sub = (verb: string, pattern: RegExp) => (method === verb ? rest.match(pattern) : null);

  if (sub("GET", /^$/)) {
    await m.data.refreshKeys();
    return json(await view(db, m, spaceId, now()));
  }

  if (sub("POST", /^\/watchlist$/)) {
    const b = await readBody(req);
    return json(addToWatchlist(db, spaceId, symbolOf(b.key), typeof b.name === "string" ? b.name : ""));
  }
  const wl = sub("DELETE", /^\/watchlist\/([^/]+)$/);
  if (wl) {
    removeFromWatchlist(db, spaceId, decodeURIComponent(wl[1]!));
    return json({ ok: true });
  }

  const owned = (id: string) => {
    const h = listHoldings(db, spaceId).find((x) => x.id === id);
    if (!h) throw new HttpError(404, "No such holding in this space.");
    return h;
  };
  if (sub("POST", /^\/holdings$/)) {
    const b = await readBody(req);
    const i = symbolOf(b.key);
    if (typeof b.account !== "string" || !b.account.trim()) throw new HttpError(400, "Name the account, like TFSA or RRSP.");
    const bookValue = b.bookValue === undefined || b.bookValue === null ? null : numberOf(b.bookValue, "Book value");
    return json(
      check(() =>
        addHolding(db, spaceId, {
          account: (b.account as string).trim(),
          symbol: i.symbol,
          exchange: i.exchange,
          name: typeof b.name === "string" ? b.name : "",
          quantity: numberOf(b.quantity, "Quantity"),
          bookValue,
          currency: currencyOf(b.currency),
        }),
      ),
    );
  }
  const hp = sub("PATCH", /^\/holdings\/([^/]+)$/);
  if (hp) {
    owned(hp[1]!);
    const b = await readBody(req);
    const patch: Parameters<typeof updateHolding>[2] = {};
    if (b.key !== undefined) Object.assign(patch, symbolOf(b.key));
    if (b.account !== undefined) {
      if (typeof b.account !== "string" || !b.account.trim()) throw new HttpError(400, "Name the account, like TFSA or RRSP.");
      patch.account = b.account.trim();
    }
    if (b.quantity !== undefined) patch.quantity = numberOf(b.quantity, "Quantity");
    if (b.bookValue !== undefined) patch.bookValue = b.bookValue === null ? null : numberOf(b.bookValue, "Book value");
    if (b.currency !== undefined) patch.currency = currencyOf(b.currency);
    if (b.name !== undefined && typeof b.name === "string") patch.name = b.name;
    return json(check(() => updateHolding(db, hp[1]!, patch)));
  }
  const hd = sub("DELETE", /^\/holdings\/([^/]+)$/);
  if (hd) {
    owned(hd[1]!);
    removeHolding(db, hd[1]!);
    return json({ ok: true });
  }

  if (sub("POST", /^\/import\/preview$/)) {
    const o = importOpts(await readBody(req));
    return json(previewImport(o.csv, o));
  }
  if (sub("POST", /^\/import$/)) {
    // Only the csv is trusted: the rows are parsed again here, whatever the client sent alongside.
    const o = importOpts(await readBody(req));
    const p = previewImport(o.csv, o);
    if (!p.rows.length) throw new HttpError(400, p.warnings[0] ?? "Nothing in that file could be imported.");
    const source = p.format === "wealthsimple_activity" ? "wealthsimple_activity" : "wealthsimple_holdings";
    const r = replaceImported(db, spaceId, source, p.accounts, p.rows);
    return json({ ...r, skipped: p.skipped });
  }

  const ownedAlert = (id: string) => {
    if (!listAlerts(db, spaceId).some((a) => a.id === id)) throw new HttpError(404, "No such alert in this space.");
  };
  if (sub("POST", /^\/alerts$/)) {
    const b = await readBody(req);
    if (b.repeat !== undefined && typeof b.repeat !== "boolean") throw new HttpError(400, "repeat must be true or false.");
    return json(
      check(() =>
        createAlert(db, {
          spaceId,
          key: typeof b.key === "string" ? b.key : "",
          rule: b.rule as AlertRule,
          note: typeof b.note === "string" ? b.note : undefined,
          repeat: b.repeat as boolean | undefined,
        }),
      ),
    );
  }
  // Alert items carry no alert id; their title is the alert's key and rule, which is how they're matched back.
  if (sub("POST", /^\/alerts\/off-from-approval$/)) {
    const b = await readBody(req);
    const a = typeof b.approvalId === "string" ? getApproval(db, b.approvalId) : null;
    const matches = a && a.spaceId === spaceId && a.kind === "alert" ? listAlerts(db, spaceId).filter((x) => [describeRule(x.rule, x.key), describeRule(x.rule)].some((r) => `${x.key} ${r}` === a.title)) : [];
    if (!matches.length) throw new HttpError(404, "That alert no longer exists.");
    for (const x of matches) setAlertStatus(db, x.id, "off");
    return json({ ok: true });
  }
  const ap = sub("PATCH", /^\/alerts\/([^/]+)$/);
  if (ap) {
    ownedAlert(ap[1]!);
    const b = await readBody(req);
    if (b.status !== "armed" && b.status !== "off") throw new HttpError(400, "status must be armed or off.");
    return json(setAlertStatus(db, ap[1]!, b.status));
  }
  const ad = sub("DELETE", /^\/alerts\/([^/]+)$/);
  if (ad) {
    ownedAlert(ad[1]!);
    removeAlert(db, ad[1]!);
    return json({ ok: true });
  }

  if (sub("POST", /^\/paper\/orders$/)) {
    const b = await readBody(req);
    const i = symbolOf(b.symbol);
    if (b.side !== "buy" && b.side !== "sell") throw new HttpError(400, "side must be buy or sell.");
    const key = instrumentKey(i);
    const r = placePaperOrder(
      db,
      { spaceId, symbol: key, side: b.side, qty: numberOf(b.qty, "Quantity"), reasoning: typeof b.reasoning === "string" ? b.reasoning : "", actor: "you" },
      currentQuote(db, m, i),
      now(),
    );
    if (!r.ok) throw new HttpError(422, r.reason);
    return json({ fill: r.fill });
  }
  if (sub("POST", /^\/paper\/reset$/)) {
    const b = await readBody(req);
    const cash = numberOf(b.startingCash, "Starting cash");
    if (cash < 1_000 || cash > 10_000_000) throw new HttpError(400, "Starting cash must be from $1,000 to $10,000,000.");
    resetAccount(db, spaceId, cash, now());
    return json({ ok: true });
  }

  if (sub("POST", /^\/strategies$/)) {
    const b = await readBody(req);
    const summary = typeof b.backtestSummary === "string" ? b.backtestSummary : undefined;
    return json(check(() => proposeStrategy(db, spaceId, b as unknown as StrategyInput, "you", summary)));
  }
  const sp = sub("PATCH", /^\/strategies\/([^/]+)$/);
  if (sp) {
    if (!listStrategies(db, spaceId).some((s) => s.id === sp[1])) throw new HttpError(404, "No such strategy in this space.");
    const b = await readBody(req);
    if (typeof b.paused !== "boolean") throw new HttpError(400, "paused must be true or false.");
    const s = check(() => setStrategyPaused(db, sp[1]!, b.paused as boolean));
    await m.feed.reevaluate();
    return json(s);
  }

  if (sub("POST", /^\/backtest$/)) {
    const b = await readBody(req);
    const i = symbolOf(b.key);
    const template = templateOf(b.template);
    const range = rangeOf(b.range ?? "1Y");
    if (range === "5D") throw new HttpError(400, "Backtests use daily bars: pick 1M, 3M, 6M or 1Y.");
    const bars = await m.data.bars(i, range);
    if (!bars.bars.length) throw new HttpError(422, bars.note ?? "There's no price history for that symbol yet.");
    return json(backtest(bars.bars, template));
  }

  throw new HttpError(404, "Not found.");
}


const currentQuote = (db: Database, m: MarketsDeps, i: Instrument) => current(db, m.data, i);

async function view(db: Database, m: MarketsDeps, spaceId: string, at: number): Promise<MarketsView> {
  const watchlist = listWatchlist(db, spaceId);
  const holdings = listHoldings(db, spaceId);
  const all = new Map<string, Instrument>();
  for (const x of [...watchlist, ...holdings]) all.set(x.key, { symbol: x.symbol, exchange: x.exchange });
  const close = lastCompletedSession(at).closesAt;
  const tried = refreshed.get(m.data) ?? new Map<string, number>();
  refreshed.set(m.data, tried);
  const stale = [...all.values()].filter((i) => {
    const p = m.data.providerFor(i);
    if (!p) return false;
    const q = currentQuote(db, m, i);
    if (q && q.at >= close) return false;
    const key = `${p.id}:${instrumentKey(i)}`;
    if (tried.get(key) === close) return false;
    tried.set(key, close);
    return true;
  });
  if (stale.length) await m.data.quotes(stale);
  const price = <T extends Instrument>(x: T): Priced<T> => {
    const quote = currentQuote(db, m, x);
    return { ...x, quote, missing: quote ? null : (m.data.reasonFor(x) ?? "No price yet; Atrium checks again during market hours.") };
  };
  const paperKeys = db.query("SELECT DISTINCT symbol FROM paper_fills WHERE space_id = ?").all(spaceId) as { symbol: string }[];
  const paperQuotes = new Map<string, Quote>();
  for (const { symbol } of paperKeys) {
    const q = currentQuote(db, m, { symbol, exchange: "US" });
    if (q) paperQuotes.set(symbol, q);
  }
  return {
    spaceId,
    watchlist: watchlist.map(price),
    holdings: holdings.map(price),
    paper: paperState(db, spaceId, paperQuotes, at),
    alerts: listAlerts(db, spaceId),
    strategies: listStrategies(db, spaceId),
    feed: m.feed.status(),
    data: await m.data.status(),
    portfolio: portfolioDay(db, m.data, spaceId, at),
    estimates: estimates(db, m, [...all.keys()], at),
    fx: latestFx(db),
    advanced: isAdvanced(db, spaceId),
  };
}

function estimates(db: Database, m: MarketsDeps, keys: string[], at: number): Record<string, Sourced> {
  const out: Record<string, Sourced> = {};
  for (const key of keys) {
    const cfg = ESTIMATED[key];
    if (!cfg) continue;
    const e = estimateFor(db, key, currentQuote(db, m, parseInstrumentKey(cfg.proxy)!), at);
    if (e) out[key] = e;
  }
  return out;
}

// Shape check, then a live check with a provider that's thrown away, then the Keychain. Neither the key nor
// anything that might echo it goes into the response.
async function saveKeys(db: Database, m: MarketsDeps, b: Record<string, unknown>, now: () => number) {
  const provider = b.provider;
  if (provider !== "alpaca" && provider !== "finnhub" && provider !== "alphavantage" && provider !== "tiingo") {
    throw new HttpError(400, "provider must be alpaca, finnhub, alphavantage or tiingo.");
  }
  const field = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const io = { fetch: m.fetch, now };
  let entries: [string, string][];
  let probe: MarketProvider;
  if (provider === "alpaca") {
    const keyId = field(b.keyId);
    const secret = field(b.secret);
    if (!isKeyShaped(keyId) || !isKeyShaped(secret)) throw new HttpError(400, SHAPE.alpaca);
    entries = [[KEY_ACCOUNTS.alpacaKeyId, keyId], [KEY_ACCOUNTS.alpacaSecret, secret]];
    probe = alpacaProvider({ keyId, secret }, io);
  } else if (provider === "finnhub") {
    const token = field(b.token);
    if (!isKeyShaped(token)) throw new HttpError(400, SHAPE.finnhub);
    entries = [[KEY_ACCOUNTS.finnhub, token]];
    probe = finnhubProvider(token, io);
  } else if (provider === "tiingo") {
    const token = field(b.token);
    if (!isKeyShaped(token)) throw new HttpError(400, SHAPE.tiingo);
    entries = [[KEY_ACCOUNTS.tiingo, token]];
    probe = tiingoProvider(token, {
      fetch: m.fetch,
      now,
      budget: { day: dailyBudget(db, "tiingo", TIINGO_DAILY_LIMIT, now), hour: hourlyBudget(db, "tiingo", TIINGO_HOURLY_LIMIT, now) },
      symbols: tiingoSymbols(db, now),
    });
  } else {
    const key = field(b.key);
    if (!isKeyShaped(key)) throw new HttpError(400, SHAPE.alphavantage);
    entries = [[KEY_ACCOUNTS.alphavantage, key]];
    probe = alphaVantageProvider(key, { budget: dailyBudget(db, "alphavantage", AV_DAILY_LIMIT, now), fetch: m.fetch, now });
  }
  const secrets = [...entries.map(([, v]) => v), ...m.data.secrets()];
  try {
    await probe.validate();
  } catch (e) {
    throw new HttpError(422, redact(e instanceof Error ? e.message : String(e), secrets));
  }
  // A key ID without its secret is useless, so a pair is saved whole or the old pair is put back.
  const previous = await Promise.all(entries.map(async ([account]) => [account, await m.keychain.get(account).catch(() => null)] as const));
  try {
    for (const [account, value] of entries) await m.keychain.set(account, value);
  } catch (e) {
    for (const [account, old] of previous) await (old ? m.keychain.set(account, old) : m.keychain.remove(account)).catch(() => {});
    if (e instanceof KeychainError) throw new HttpError(422, e.message);
    throw e;
  }
  await m.data.reload();
  await m.feed.reevaluate();
  return { ok: true, message: "Saved in your Mac's Keychain." };
}
