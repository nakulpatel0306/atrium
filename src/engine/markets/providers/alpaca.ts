import { instrumentKey, type Instrument } from "../instrument";
import { fetchJson, RECONNECT_MS } from "./http";
import { type Bar, type MarketProvider, type NewsItem, type Quote, type QuoteStream, type StreamEvents } from "./types";

// Market data only. Alpaca's trading hosts are never referenced anywhere in Atrium.
const DATA = "https://data.alpaca.markets";
const STREAM = "wss://stream.data.alpaca.markets/v2/iex";
const AUTH_MESSAGE = "Alpaca rejected the key. Check the key ID and secret in Settings → Market data.";
const BATCH = 100;
// The free plan can't read SIP data from the latest 15 minutes.
const SIP_DELAY_MS = 16 * 60_000;

type Trade = { p: number; t: string };
type Snapshot = { latestTrade?: Trade; prevDailyBar?: { c: number } };
type RawBar = { t: string; o: number; h: number; l: number; c: number; v: number };

type Deps = {
  fetch?: typeof fetch;
  WebSocket?: typeof WebSocket;
  now?: () => number;
  timers?: { set: typeof setTimeout; clear: typeof clearTimeout };
};

export function alpacaProvider(creds: { keyId: string; secret: string }, deps: Deps = {}): MarketProvider {
  const f = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const WS = deps.WebSocket ?? WebSocket;
  const timers = deps.timers ?? { set: setTimeout, clear: clearTimeout };
  // Stream trades carry no previous close, so the last snapshot's is reused.
  const prevCloses = new Map<string, number>();

  const get = (path: string, params: Record<string, string>, signal?: AbortSignal) =>
    fetchJson(`${DATA}${path}?${new URLSearchParams(params)}`, {
      fetch: f,
      name: "Alpaca",
      authMessage: AUTH_MESSAGE,
      now,
      signal,
      headers: { "APCA-API-KEY-ID": creds.keyId, "APCA-API-SECRET-KEY": creds.secret },
    });

  const quotes = async (list: Instrument[], signal?: AbortSignal): Promise<Quote[]> => {
    const out: Quote[] = [];
    for (let i = 0; i < list.length; i += BATCH) {
      const batch = list.slice(i, i + BATCH);
      const snaps = (await get("/v2/stocks/snapshots", { symbols: batch.map((x) => x.symbol).join(","), feed: "iex" }, signal)) as Record<string, Snapshot>;
      for (const inst of batch) {
        const s = snaps[inst.symbol];
        if (!s?.latestTrade) continue;
        const prevClose = s.prevDailyBar?.c ?? null;
        if (prevClose !== null) prevCloses.set(inst.symbol, prevClose);
        out.push({ key: instrumentKey(inst), price: s.latestTrade.p, prevClose, at: Date.parse(s.latestTrade.t), source: "alpaca", freshness: "live" });
      }
    }
    return out;
  };

  const bars = async (i: Instrument, tf: "1Day" | "5Min", from: number, to: number, signal?: AbortSignal): Promise<Bar[]> => {
    const daily = tf === "1Day";
    const end = daily ? Math.min(to, now() - SIP_DELAY_MS) : to;
    const out: Bar[] = [];
    let token: string | null = null;
    do {
      const params: Record<string, string> = {
        symbols: i.symbol,
        timeframe: tf,
        start: new Date(from).toISOString(),
        end: new Date(end).toISOString(),
        feed: daily ? "sip" : "iex",
        adjustment: "split",
        limit: "10000",
      };
      if (token) params.page_token = token;
      const page = (await get("/v2/stocks/bars", params, signal)) as { bars?: Record<string, RawBar[]>; next_page_token?: string | null };
      for (const b of page.bars?.[i.symbol] ?? []) out.push({ t: Date.parse(b.t) / 1000, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
      token = page.next_page_token ?? null;
    } while (token);
    return out;
  };

  const news = async (list: Instrument[], since: number): Promise<NewsItem[]> => {
    const symbols = list.map((x) => x.symbol);
    const res = (await get("/v1beta1/news", { symbols: symbols.join(","), start: new Date(since).toISOString(), limit: "50" })) as {
      news?: { headline: string; source: string; url: string; created_at: string; symbols: string[] }[];
    };
    const out: NewsItem[] = [];
    for (const n of res.news ?? []) {
      for (const s of n.symbols) {
        if (symbols.includes(s)) out.push({ key: s, headline: n.headline, source: n.source, url: n.url, at: Date.parse(n.created_at) });
      }
    }
    return out;
  };

  const stream = (list: Instrument[], ev: StreamEvents): QuoteStream => {
    let symbols = list.map((x) => x.symbol);
    let ws: WebSocket | null = null;
    let authed = false;
    let stopped = false;
    let attempt = 0;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const send = (msg: unknown) => ws?.send(JSON.stringify(msg));
    const fatal = (message: string) => {
      stopped = true;
      ev.status({ ok: false, message });
      ws?.close();
    };
    const connect = () => {
      authed = false;
      const sock = new WS(STREAM);
      ws = sock;
      sock.onmessage = (e: MessageEvent) => {
        let msgs: { T: string; msg?: string; code?: number; S?: string; p?: number; t?: string }[];
        try {
          msgs = JSON.parse(String(e.data));
        } catch {
          return;
        }
        for (const m of Array.isArray(msgs) ? msgs : []) {
          if (m.T === "success" && m.msg === "connected") send({ action: "auth", key: creds.keyId, secret: creds.secret });
          else if (m.T === "success" && m.msg === "authenticated") {
            authed = true;
            attempt = 0;
            ev.status({ ok: true, message: "IEX real-time" });
            if (symbols.length) send({ action: "subscribe", trades: symbols });
          } else if (m.T === "error") {
            if (m.code === 406) fatal("Alpaca allows one live connection on the free plan, and another app is using it. Checking every 3 minutes instead.");
            else if (m.code === 402) fatal(AUTH_MESSAGE);
            else if (m.code === 405) fatal("Alpaca's free plan streams at most 30 symbols. Checking every 3 minutes instead.");
            else ev.status({ ok: false, message: "Alpaca's live feed reported a problem. Checking every 3 minutes instead." });
          } else if (m.T === "t" && m.S && typeof m.p === "number" && m.t && symbols.includes(m.S)) {
            ev.quote({ key: m.S, price: m.p, prevClose: prevCloses.get(m.S) ?? null, at: Date.parse(m.t), source: "alpaca", freshness: "live" });
          }
        }
      };
      sock.onclose = () => {
        if (stopped || ws !== sock) return;
        const delay = RECONNECT_MS[Math.min(attempt, RECONNECT_MS.length - 1)]!;
        attempt++;
        retry = timers.set(connect, delay);
      };
    };
    connect();
    return {
      set(next) {
        const nextSymbols = next.map((x) => x.symbol);
        const removed = symbols.filter((s) => !nextSymbols.includes(s));
        const added = nextSymbols.filter((s) => !symbols.includes(s));
        symbols = nextSymbols;
        if (!authed) return;
        if (removed.length) send({ action: "unsubscribe", trades: removed });
        if (added.length) send({ action: "subscribe", trades: added });
      },
      close() {
        stopped = true;
        if (retry) timers.clear(retry);
        ws?.close();
      },
    };
  };

  return {
    id: "alpaca",
    label: "Alpaca (IEX)",
    covers: (i) => i.exchange === "US",
    quotes,
    bars,
    news,
    stream,
    maxStreamSymbols: 30,
    async validate() {
      await get("/v2/stocks/snapshots", { symbols: "SPY", feed: "iex" });
    },
  };
}
