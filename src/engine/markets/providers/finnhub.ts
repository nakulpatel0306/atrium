import { etDate } from "../calendar";
import { instrumentKey, type Instrument } from "../instrument";
import { fetchJson, RECONNECT_MS } from "./http";
import { ProviderError, type MarketProvider, type NewsItem, type Quote, type QuoteStream, type StreamEvents } from "./types";

const API = "https://finnhub.io/api/v1";
const AUTH_MESSAGE = "Finnhub rejected the token. Check it in Settings → Market data.";

type Deps = {
  fetch?: typeof fetch;
  WebSocket?: typeof WebSocket;
  now?: () => number;
  timers?: { set: typeof setTimeout; clear: typeof clearTimeout };
};

// The token travels in the query string, so URLs are never logged or echoed (see http.ts).
export function finnhubProvider(token: string, deps: Deps = {}): MarketProvider {
  const f = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const WS = deps.WebSocket ?? WebSocket;
  const timers = deps.timers ?? { set: setTimeout, clear: clearTimeout };
  const prevCloses = new Map<string, number>();

  const get = (path: string, params: Record<string, string>, signal?: AbortSignal) =>
    fetchJson(`${API}${path}?${new URLSearchParams({ ...params, token })}`, { fetch: f, name: "Finnhub", authMessage: AUTH_MESSAGE, now, signal });

  const quotes = async (list: Instrument[], signal?: AbortSignal): Promise<Quote[]> => {
    const out: Quote[] = [];
    for (const i of list) {
      const q = (await get("/quote", { symbol: i.symbol }, signal)) as { c: number; pc: number; t: number };
      if (!q.c && !q.t) throw new ProviderError("unknown_symbol", `Finnhub doesn't know ${instrumentKey(i)}.`);
      if (q.pc) prevCloses.set(i.symbol, q.pc);
      out.push({ key: instrumentKey(i), price: q.c, prevClose: q.pc || null, at: q.t * 1000, source: "finnhub", freshness: "live" });
    }
    return out;
  };

  const news = async (list: Instrument[], since: number): Promise<NewsItem[]> => {
    const out: NewsItem[] = [];
    for (const i of list) {
      const items = (await get("/company-news", { symbol: i.symbol, from: etDate(since), to: etDate(now()) })) as {
        datetime: number;
        headline: string;
        source: string;
        url: string;
      }[];
      for (const n of items) out.push({ key: instrumentKey(i), headline: n.headline, source: n.source, url: n.url, at: n.datetime * 1000 });
    }
    return out;
  };

  const stream = (list: Instrument[], ev: StreamEvents): QuoteStream => {
    let symbols = list.map((x) => x.symbol);
    let ws: WebSocket | null = null;
    let isOpen = false;
    let stopped = false;
    let attempt = 0;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const send = (msg: unknown) => ws?.send(JSON.stringify(msg));
    const connect = () => {
      isOpen = false;
      const sock = new WS(`wss://ws.finnhub.io?${new URLSearchParams({ token })}`);
      ws = sock;
      sock.onopen = () => {
        isOpen = true;
        attempt = 0;
        ev.status({ ok: true, message: "Finnhub real-time" });
        for (const s of symbols) send({ type: "subscribe", symbol: s });
      };
      sock.onmessage = (e: MessageEvent) => {
        let m: { type?: string; data?: { s: string; p: number; t: number }[] };
        try {
          m = JSON.parse(String(e.data));
        } catch {
          return;
        }
        if (m.type === "error") ev.status({ ok: false, message: "Finnhub's live feed reported a problem. Checking every 3 minutes instead." });
        if (m.type !== "trade") return;
        for (const t of m.data ?? []) {
          if (!symbols.includes(t.s)) continue;
          ev.quote({ key: t.s, price: t.p, prevClose: prevCloses.get(t.s) ?? null, at: t.t, source: "finnhub", freshness: "live" });
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
        if (!isOpen) return;
        for (const s of removed) send({ type: "unsubscribe", symbol: s });
        for (const s of added) send({ type: "subscribe", symbol: s });
      },
      close() {
        stopped = true;
        if (retry) timers.clear(retry);
        ws?.close();
      },
    };
  };

  return {
    id: "finnhub",
    label: "Finnhub",
    covers: (i) => i.exchange === "US",
    quotes,
    async bars() {
      throw new ProviderError("no_history", "Finnhub's free plan has no price history. Switch to Alpaca in Settings → Market data for charts.");
    },
    news,
    stream,
    maxStreamSymbols: 50,
    async validate() {
      await quotes([{ symbol: "SPY", exchange: "US" }]);
    },
  };
}
