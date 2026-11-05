import type { Database } from "bun:sqlite";
import { bus } from "../events";
import { saveQuotes } from "./cache";
import { etClock, etDate, etInstant, usSession, type Session } from "./calendar";
import type { MarketData } from "./data";
import { instrumentKey, parseInstrumentKey, type Exchange, type Instrument } from "./instrument";
import type { Quote, QuoteStream } from "./providers/types";

export const POLL_MS = 180_000;
export const OFF_RECHECK_MS = 900_000;
export const FLUSH_MS = 1_000;
const CHANGED_DEBOUNCE_MS = 250;
const MIN_TIMER_MS = 1_000;
// A streamed symbol this long without a trade is polled instead; when every one is that quiet, the stream is
// presumed dead (a half-open socket after sleep) and reconnected.
export const STALE_MS = 300_000;

export type FeedMode = "stream" | "poll" | "off";
export type FeedStatus = { mode: FeedMode; reason: string; session: Session; lastQuoteAt: number | null; streamError: string | null };

const weekdayFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" });

export function feedMode(i: {
  session: Session;
  hasSymbols: boolean;
  ready: boolean;
  viewers: number;
  strategyActive: boolean;
  canStream: boolean;
  notReadyMessage?: string;
}): { mode: FeedMode; reason: string } {
  if (!i.hasSymbols) return { mode: "off", reason: "Stopped · no symbols to watch" };
  if (i.session.holiday) return { mode: "off", reason: `Stopped · market holiday (${i.session.holiday})` };
  if (!i.session.open) {
    return { mode: "off", reason: `Stopped · market closed until ${weekdayFmt.format(i.session.nextOpen)} ${etClock(i.session.nextOpen)}` };
  }
  if (!i.ready) return { mode: "off", reason: `Stopped · ${i.notReadyMessage ?? "no market data source"}` };
  if (i.canStream && i.viewers > 0) return { mode: "stream", reason: "Streaming · market open, dashboard open" };
  if (i.canStream && i.strategyActive) return { mode: "stream", reason: "Streaming · paper strategy running" };
  return { mode: "poll", reason: "Checking every 3 minutes · market open" };
}

// What the feed watches, across active markets spaces: what you hold on paper first (fills depend on fresh
// prices), then real holdings, active strategy symbols and the watchlist. Streams are capped, so order matters.
export function trackedInstruments(db: Database): Instrument[] {
  const out: Instrument[] = [];
  const seen = new Set<string>();
  const add = (i: Instrument | null) => {
    if (!i) return;
    const k = instrumentKey(i);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(i);
  };
  const active = "SELECT id FROM spaces WHERE kind = 'markets' AND status = 'active'";
  const paper = db
    .query(
      `SELECT f.symbol, SUM(CASE WHEN f.side = 'buy' THEN f.qty ELSE -f.qty END) AS net, MIN(f.created_at) AS first
       FROM paper_fills f LEFT JOIN paper_accounts a ON a.space_id = f.space_id
       WHERE f.space_id IN (${active}) AND f.created_at >= COALESCE(a.reset_at, 0)
       GROUP BY f.space_id, f.symbol HAVING net > 1e-9 ORDER BY first`,
    )
    .all() as { symbol: string }[];
  for (const r of paper) add(parseInstrumentKey(r.symbol));
  const holdings = db
    .query(`SELECT symbol, exchange FROM market_holdings WHERE space_id IN (${active}) ORDER BY updated_at, rowid`)
    .all() as { symbol: string; exchange: Exchange }[];
  for (const h of holdings) add({ symbol: h.symbol, exchange: h.exchange });
  const strategies = db
    .query(`SELECT symbols FROM market_strategies WHERE status = 'active' AND space_id IN (${active}) ORDER BY created_at, rowid`)
    .all() as { symbols: string }[];
  for (const s of strategies) for (const k of JSON.parse(s.symbols) as string[]) add(parseInstrumentKey(k));
  const watch = db
    .query(`SELECT symbol, exchange FROM market_watchlist WHERE space_id IN (${active}) ORDER BY added_at, rowid`)
    .all() as { symbol: string; exchange: Exchange }[];
  for (const w of watch) add({ symbol: w.symbol, exchange: w.exchange });
  return out;
}

type Timers = { set: typeof setTimeout; clear: typeof clearTimeout };

export function createFeed(deps: {
  db: Database;
  data: MarketData;
  onQuotes(q: Quote[]): void;
  strategyActive(): boolean;
  // Runs on every in-session tick; the engine enqueues due paper strategies here.
  onTick?(now: number): void;
  now?: () => number;
  timers?: Timers;
}) {
  const { db, data } = deps;
  const now = deps.now ?? Date.now;
  const timers: Timers = deps.timers ?? { set: setTimeout, clear: clearTimeout };

  let mode: FeedMode = "off";
  let reason = "Stopped · starting";
  let viewers = 0;
  let lastQuoteAt: number | null = null;
  let streamError: string | null = null;
  let streamBlocked = false;
  let stream: QuoteStream | null = null;
  let streamKeys = "";
  let lastKeys = "";
  let barsDate: string | null = null;
  let eodDate: string | null = null;
  let mainTimer: ReturnType<typeof setTimeout> | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> = Promise.resolve();
  let started = false;
  let offBus: (() => void) | null = null;
  const buffer = new Map<string, Quote>();
  const tickAt = new Map<string, number>();
  let streamSince = 0;

  const publish = (quotes: Quote[]) => {
    if (!quotes.length) return;
    lastQuoteAt = Math.max(lastQuoteAt ?? 0, ...quotes.map((q) => q.at));
    bus.emit({ type: "quotes", quotes });
    deps.onQuotes(quotes);
  };

  const fetchQuotes = async (list: Instrument[]) => {
    if (!list.length) return;
    try {
      // data.quotes caches what it gets.
      const r = await data.quotes(list);
      publish(r.quotes);
    } catch (e) {
      console.error(`Market data refresh failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const flush = () => {
    flushTimer = null;
    const quotes = [...buffer.values()];
    buffer.clear();
    if (!quotes.length) return;
    saveQuotes(db, quotes);
    publish(quotes);
  };

  // Stream ticks arrive many times a second; they're batched so the DB and dashboard see at most one write a second.
  const onStreamQuote = (q: Quote) => {
    tickAt.set(q.key, now());
    buffer.set(q.key, q);
    if (!flushTimer) flushTimer = timers.set(flush, FLUSH_MS);
  };

  const closeStream = () => {
    stream?.close();
    stream = null;
    streamKeys = "";
    tickAt.clear();
  };

  const schedule = (delay: number, keep: boolean) => {
    if (keep && mainTimer) return;
    if (mainTimer) timers.clear(mainTimer);
    mainTimer = timers.set(() => {
      mainTimer = null;
      void queue("timer");
    }, Math.max(MIN_TIMER_MS, delay));
  };

  const clearMain = () => {
    if (mainTimer) timers.clear(mainTimer);
    mainTimer = null;
  };

  const step = async (trigger: "timer" | "eval") => {
    if (!started) return;
    const at = now();
    const session = usSession(at);
    const tracked = trackedInstruments(db);
    const status = await data.status();
    const pollable = tracked.filter((i) => {
      const p = data.providerFor(i);
      return p !== null && p.id !== "alphavantage";
    });
    const streamer = data.streamer();
    const canStream = !!streamer?.stream && !streamBlocked;
    const next = feedMode({
      session,
      hasSymbols: tracked.length > 0,
      ready: status.us.ready,
      viewers,
      strategyActive: deps.strategyActive(),
      canStream,
      notReadyMessage: status.us.message,
    });
    const prev = mode;
    mode = next.mode;
    reason = next.reason;
    const keys = pollable.map(instrumentKey).join(",");
    const trackedChanged = keys !== lastKeys;
    lastKeys = keys;

    if (mode !== "stream") closeStream();

    if (mode === "off") {
      // One last price at the close, so the day's close is what's cached overnight.
      if (prev !== "off" && session.closesAt !== null && at >= session.closesAt) await fetchQuotes(pollable);
      const today = etDate(at);
      const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
      const eod = tracked.filter((i) => data.providerFor(i)?.id === "alphavantage");
      if (eod.length && dow !== 0 && dow !== 6 && at >= etInstant(today, "16:30") && eodDate !== today) {
        eodDate = today;
        await fetchQuotes(eod);
      }
      if (!tracked.length) clearMain();
      else schedule(Math.min(session.nextOpen - at, OFF_RECHECK_MS), trigger !== "timer" && prev === "off");
      return;
    }

    const max = streamer?.maxStreamSymbols ?? 0;
    let stale: Instrument[] = [];
    if (mode === "stream" && streamer?.stream) {
      const wanted = pollable.slice(0, max);
      const wantedKeys = wanted.map(instrumentKey).join(",");
      if (stream && trigger === "timer") {
        stale = wanted.filter((i) => at - (tickAt.get(instrumentKey(i)) ?? streamSince) >= STALE_MS);
        if (wanted.length && stale.length === wanted.length) closeStream();
      }
      if (!stream) {
        streamSince = at;
        stream = streamer.stream(wanted, {
          quote: onStreamQuote,
          status: (s) => {
            if (s.ok) {
              streamError = null;
              return;
            }
            streamError = s.message;
            streamBlocked = true;
            closeStream();
            void queue("eval");
          },
        });
        streamKeys = wantedKeys;
      } else if (wantedKeys !== streamKeys) {
        stream.set(wanted);
        streamKeys = wantedKeys;
      }
    }

    const fresh = prev === "off" || trigger === "timer" || trackedChanged;
    if (fresh) {
      const list = mode === "stream" && prev !== "off" && !trackedChanged ? [...stale, ...pollable.slice(max)] : pollable;
      await fetchQuotes(list);
    }
    const today = etDate(at);
    if (barsDate !== today) {
      barsDate = today;
      // Indicator alerts and agent context read cached daily bars; once a day keeps them current.
      for (const i of tracked) {
        const p = data.providerFor(i);
        if (!p || p.id === "finnhub") continue;
        try {
          await data.bars(i, "6M");
        } catch {
          // The cache stays as it was.
        }
      }
    }
    deps.onTick?.(at);
    const untilClose = (session.closesAt ?? at + POLL_MS) - at;
    schedule(Math.min(POLL_MS, untilClose), trigger !== "timer" && prev !== "off");
  };

  const queue = (trigger: "timer" | "eval"): Promise<void> => {
    running = running.then(() => step(trigger)).catch((e) => console.error(`Market feed: ${e instanceof Error ? e.message : String(e)}`));
    return running;
  };

  return {
    start(): Promise<void> {
      started = true;
      offBus = bus.on((e) => {
        if (e.type !== "changed") return;
        if (debounce) timers.clear(debounce);
        debounce = timers.set(() => {
          debounce = null;
          void queue("eval");
        }, CHANGED_DEBOUNCE_MS);
      });
      return queue("eval");
    },
    stop(): void {
      started = false;
      offBus?.();
      offBus = null;
      closeStream();
      clearMain();
      if (debounce) timers.clear(debounce);
      if (flushTimer) timers.clear(flushTimer);
      debounce = null;
      flushTimer = null;
    },
    setViewers(n: number): Promise<void> {
      // A new viewer gets another try at streaming after a refused connection.
      if (viewers === 0 && n > 0) streamBlocked = false;
      viewers = n;
      return queue("eval");
    },
    reevaluate(): Promise<void> {
      streamBlocked = false;
      return queue("eval");
    },
    async refreshNow(): Promise<void> {
      await fetchQuotes(trackedInstruments(db).filter((i) => data.providerFor(i) !== null));
    },
    idle: (): Promise<void> => running,
    status(): FeedStatus {
      return { mode, reason, session: usSession(now()), lastQuoteAt, streamError };
    },
  };
}

export type Feed = ReturnType<typeof createFeed>;
