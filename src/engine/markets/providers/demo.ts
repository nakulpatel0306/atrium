import { etDate, etInstant, usSession } from "../calendar";
import { instrumentKey, parseInstrumentKey, type Instrument } from "../instrument";
import type { Bar, MarketProvider, Quote, QuoteStream, Timeframe } from "./types";

// Prices start from here so a series is the same whatever range is asked for.
const WALK_START = "2024-01-02";
const DAY_MS = 86_400_000;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round = (n: number) => Math.round(n * 100) / 100;
const nextDate = (d: string) => new Date(Date.parse(`${d}T12:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

const tradingCache = new Map<string, boolean>();
function isTradingDay(date: string): boolean {
  let v = tradingCache.get(date);
  if (v === undefined) {
    v = usSession(etInstant(date, "12:00")).opensAt !== null;
    tradingCache.set(date, v);
  }
  return v;
}

type Day = { date: string; bar: Bar };

// Every trading day's bar from WALK_START through `lastDate`, a seeded random walk per key.
function dailySeries(key: string, lastDate: string): Day[] {
  const h = hash(key);
  const rand = mulberry32(h);
  let close = 20 + (h % 480);
  const out: Day[] = [];
  for (let d = WALK_START; d <= lastDate; d = nextDate(d)) {
    if (!isTradingDay(d)) continue;
    const o = close * (1 + (rand() - 0.5) * 0.01);
    const c = o * (1 + (rand() - 0.5) * 0.04);
    const hi = Math.max(o, c) * (1 + rand() * 0.012);
    const lo = Math.min(o, c) * (1 - rand() * 0.012);
    const v = Math.round(800_000 + rand() * 4_000_000);
    out.push({ date: d, bar: { t: etInstant(d, "00:00") / 1000, o: round(o), h: round(hi), l: round(lo), c: round(c), v } });
    close = c;
  }
  return out;
}

// Sessions whose close has passed.
function completed(key: string, now: number): Day[] {
  const s = usSession(now);
  const today = etDate(now);
  const all = dailySeries(key, today);
  const todayDone = s.closesAt !== null && now >= s.closesAt;
  return all.at(-1)?.date === today && !todayDone ? all.slice(0, -1) : all;
}

const seedOf = (key: string) => (hash(key) % 1000) / 100;

function intraday(key: string, lastClose: number, opensAt: number, at: number): number {
  const minutes = (at - opensAt) / 60_000;
  return round(lastClose * (1 + 0.012 * Math.sin(minutes / 37 + seedOf(key))));
}

// What demo search can find: a few well-known names.
const DEMO_CATALOG: { key: string; name: string; type: string }[] = [
  { key: "AAPL", name: "Apple Inc", type: "Common Stock" },
  { key: "AMZN", name: "Amazon.com Inc", type: "Common Stock" },
  { key: "ATZ.TO", name: "Aritzia Inc", type: "Common Stock" },
  { key: "DRAM", name: "Roundhill Memory ETF", type: "ETP" },
  { key: "MARS", name: "Roundhill Space & Technology ETF", type: "ETP" },
  { key: "META", name: "Meta Platforms Inc", type: "Common Stock" },
  { key: "MSFT", name: "Microsoft Corp", type: "Common Stock" },
  { key: "NOW", name: "ServiceNow Inc", type: "Common Stock" },
  { key: "NVDA", name: "Nvidia Corp", type: "Common Stock" },
  { key: "QBTS", name: "D-Wave Quantum Inc", type: "Common Stock" },
  { key: "QQQ", name: "Invesco QQQ Trust", type: "ETP" },
  { key: "RKLB", name: "Rocket Lab Corp", type: "Common Stock" },
  { key: "SHOP", name: "Shopify Inc", type: "Common Stock" },
  { key: "SHOP.TO", name: "Shopify Inc", type: "Common Stock" },
  { key: "SOFI", name: "SoFi Technologies Inc", type: "Common Stock" },
  { key: "SPY", name: "SPDR S&P 500 ETF Trust", type: "ETP" },
  { key: "TSLA", name: "Tesla Inc", type: "Common Stock" },
  { key: "VFV.TO", name: "Vanguard S&P 500 Index ETF", type: "ETF" },
  { key: "XEQT.TO", name: "iShares Core Equity ETF Portfolio", type: "ETF" },
];

export function demoProvider(deps: { now?: () => number; tickMs?: number } = {}): MarketProvider {
  const now = deps.now ?? Date.now;
  const tickMs = deps.tickMs ?? 2000;

  const quote = (i: Instrument, at: number): Quote => {
    const key = instrumentKey(i);
    const days = completed(key, at);
    const last = days.at(-1)!.bar;
    const s = usSession(at);
    if (s.open && s.opensAt !== null) {
      return { key, price: intraday(key, last.c, s.opensAt, at), prevClose: last.c, at, source: "demo", freshness: "demo" };
    }
    const lastDate = days.at(-1)!.date;
    const closeAt = etInstant(lastDate, usSession(etInstant(lastDate, "12:00")).earlyClose ? "13:00" : "16:00");
    return { key, price: last.c, prevClose: days.at(-2)?.bar.c ?? null, at: closeAt, source: "demo", freshness: "demo" };
  };

  const fiveMin = (key: string, from: number, to: number): Bar[] => {
    const out: Bar[] = [];
    const end = Math.min(to, now());
    const rand = mulberry32(hash(`${key}:5m`));
    for (let d = etDate(from); d <= etDate(end); d = nextDate(d)) {
      if (!isTradingDay(d)) continue;
      const s = usSession(etInstant(d, "12:00"));
      const opensAt = s.opensAt!;
      const closesAt = s.closesAt!;
      const lastClose = completed(key, opensAt).at(-1)!.bar.c;
      for (let t = opensAt; t + 300_000 <= Math.min(closesAt, end); t += 300_000) {
        if (t < from) continue;
        const o = intraday(key, lastClose, opensAt, t);
        const c = intraday(key, lastClose, opensAt, t + 300_000);
        const hi = round(Math.max(o, c) * (1 + rand() * 0.002));
        const lo = round(Math.min(o, c) * (1 - rand() * 0.002));
        out.push({ t: t / 1000, o, h: hi, l: lo, c, v: Math.round(5_000 + rand() * 40_000) });
      }
    }
    return out;
  };

  return {
    id: "demo",
    label: "Demo data",
    covers: () => true,
    async quotes(list) {
      const at = now();
      return list.map((i) => quote(i, at));
    },
    async bars(i: Instrument, tf: Timeframe, from: number, to: number) {
      const key = instrumentKey(i);
      if (tf === "5Min") return fiveMin(key, from, to);
      const fromSec = from / 1000;
      const toSec = to / 1000;
      return completed(key, Math.min(to, now()))
        .map((d) => d.bar)
        .filter((b) => b.t >= fromSec && b.t <= toSec);
    },
    stream(list, ev): QuoteStream {
      let current = [...list];
      const timer = setInterval(() => {
        const at = now();
        if (!usSession(at).open) return;
        for (const i of current) ev.quote(quote(i, at));
      }, tickMs);
      ev.status({ ok: true, message: "Demo data" });
      return {
        set(next) {
          current = [...next];
        },
        close() {
          clearInterval(timer);
        },
      };
    },
    async metric(i) {
      const key = instrumentKey(i);
      const days = completed(key, now()).slice(-252);
      const h = hash(`${key}:metric`);
      return {
        pe: round(10 + (h % 600) / 10),
        high52: Math.max(...days.map((d) => d.bar.h)),
        low52: Math.min(...days.map((d) => d.bar.l)),
        divYield: h % 3 === 0 ? round((h % 400) / 100) : null,
        marketCap: round(1_000 + (h % 900_000)),
      };
    },
    async profile(i) {
      return {
        // Made-up data has no company name; the watchlist's names stay in use.
        name: "",
        country: i.exchange === "US" ? "US" : "CA",
        currency: i.exchange === "US" ? "USD" : "CAD",
        industry: "Technology",
        exchange: i.exchange === "US" ? "NASDAQ NMS - GLOBAL MARKET" : "TORONTO STOCK EXCHANGE",
      };
    },
    // The first symbol reports three trading days out, so earnings alerts and thesis checks can be shown.
    async earnings(list, from, to) {
      const out: { key: string; date: string; hour: string | null; epsEstimate: number | null }[] = [];
      list.forEach((i, n) => {
        const key = instrumentKey(i);
        const h = hash(`${key}:earnings`);
        let date = etDate(now());
        for (let left = n === 0 ? 3 : 10 + (h % 40); left > 0; ) {
          date = nextDate(date);
          if (isTradingDay(date)) left--;
        }
        if (date >= from && date <= to) out.push({ key, date, hour: n === 0 || h % 2 ? "amc" : "bmo", epsEstimate: round((h % 300) / 100 + 0.1) });
      });
      return out;
    },
    async search(q) {
      const t = q.trim().toLowerCase();
      return DEMO_CATALOG.filter((c) => c.key.toLowerCase().startsWith(t) || c.name.toLowerCase().includes(t)).map((c) => {
        const i = parseInstrumentKey(c.key)!;
        return { key: c.key, symbol: i.symbol, exchange: i.exchange, name: c.name, type: c.type, note: null };
      });
    },
    maxStreamSymbols: 30,
    async validate() {},
  };
}
