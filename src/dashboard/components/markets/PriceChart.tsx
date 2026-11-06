import {
  CandlestickSeries,
  createChart,
  HistogramSeries,
  LineSeries,
  TickMarkType,
  type IChartApi,
  type ISeriesApi,
  type SeriesType,
  type Time,
} from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import type { BarsResult, ChartRange } from "../../../engine/markets/data";
import type { Quote } from "../../../engine/markets/providers/types";
import { onQuotes } from "../../api";
import { chartSeries, DOWN, type Indicators, liveTime, UP } from "../../chart-data";
import type { MarketsView } from "../../markets";
import { Freshness } from "./Freshness";

const RANGES: ChartRange[] = ["5D", "1M", "3M", "6M", "1Y"];
const TOGGLES: { id: keyof Indicators; label: string }[] = [
  { id: "sma20", label: "SMA 20" },
  { id: "sma50", label: "SMA 50" },
  { id: "ema20", label: "EMA 20" },
  { id: "rsi14", label: "RSI 14" },
];
const LINE_COLOURS: Record<"sma20" | "sma50" | "ema20", string> = { sma20: "#f2c94c", sma50: "#4ea7fc", ema20: "#b07cf5" };
const SUB_PANE_SHARE = 0.22;

const etTime = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
const etDayShort = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
const utcMonth = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short" });
const utcDay = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
// Intraday times are UTC seconds, read in market time (ET); daily times are "YYYY-MM-DD" session dates.
const timeLabel = (t: Time) =>
  typeof t === "number" ? `${etDayShort.format(t * 1000)} ${etTime.format(t * 1000)}` : utcDay.format(Date.parse(`${String(t)}T12:00:00Z`));
const tickLabel = (t: Time, type: TickMarkType) => {
  if (typeof t === "number") return type <= TickMarkType.DayOfMonth ? etDayShort.format(t * 1000) : etTime.format(t * 1000);
  const d = Date.parse(`${String(t)}T12:00:00Z`);
  return type === TickMarkType.Year ? String(t).slice(0, 4) : type === TickMarkType.Month ? utcMonth.format(d) : utcDay.format(d);
};

const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// fixed: the symbol is chosen elsewhere (the Research page), so the chart shows no picker of its own.
export function PriceChart({ view, initialKey, fixed = false }: { view: MarketsView; initialKey: string | null; fixed?: boolean }) {
  const keys = [...new Set([...view.watchlist.map((w) => w.key), ...view.holdings.map((h) => h.key)])];
  const [key, setKey] = useState(initialKey ?? keys[0] ?? null);
  const [range, setRange] = useState<ChartRange>("6M");
  const [show, setShow] = useState<Indicators>({ sma20: true, sma50: true, ema20: false, rsi14: true });
  const [data, setData] = useState<BarsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<SeriesType>[]>([]);
  const candle = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const last = useRef<{ time: unknown; open: number; high: number; low: number; close: number } | null>(null);
  const row = [...view.watchlist, ...view.holdings].find((x) => x.key === key);

  useEffect(() => {
    if (!box.current) return;
    const line = cssVar("--line");
    const c = createChart(box.current, {
      autoSize: true,
      layout: { background: { color: cssVar("--panel") }, textColor: cssVar("--dim"), fontSize: 11, panes: { separatorColor: line } },
      grid: { vertLines: { color: line }, horzLines: { color: line } },
      rightPriceScale: { borderColor: line },
      timeScale: { borderColor: line },
    });
    chart.current = c;
    return () => {
      c.remove();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    if (!key) return;
    let live = true;
    setError(null);
    fetch(`/api/markets/bars?key=${encodeURIComponent(key)}&range=${range}`)
      .then(async (res) => {
        const body = await res.json();
        if (!live) return;
        if (res.ok) setData(body as BarsResult);
        else setError((body as { error?: string }).error ?? "Couldn't load the chart.");
      })
      .catch(() => live && setError("Can't reach the Atrium engine. Check that it's running."));
    return () => {
      live = false;
    };
  }, [key, range]);

  useEffect(() => {
    const c = chart.current;
    if (!c || !data) return;
    for (const s of series.current) c.removeSeries(s);
    series.current = [];
    const s = chartSeries(data.bars, data.timeframe, show);
    const up = cssVar("--green");
    const down = cssVar("--red");
    const candles = c.addSeries(CandlestickSeries, { upColor: up, downColor: down, borderVisible: false, wickUpColor: up, wickDownColor: down }, 0);
    candles.setData(s.candles);
    const volume = c.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: false }, 1);
    volume.setData(s.volume);
    series.current.push(candles, volume);
    for (const id of ["sma20", "sma50", "ema20"] as const) {
      if (!s.lines[id].length) continue;
      const l = c.addSeries(LineSeries, { color: LINE_COLOURS[id], lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, 0);
      l.setData(s.lines[id]);
      series.current.push(l);
    }
    if (s.rsi.length) {
      const r = c.addSeries(LineSeries, { color: "#b07cf5", lineWidth: 1, priceLineVisible: false }, 2);
      r.setData(s.rsi);
      series.current.push(r);
    }
    // Panes left empty by a toggle that was just switched off go away.
    while (c.panes().length > (s.rsi.length ? 3 : 2)) c.removePane(c.panes().length - 1);
    // Stretch factors share the height: the price pane keeps most of it, volume and RSI get a strip each.
    const panes = c.panes();
    panes[0]?.setStretchFactor(1);
    for (const p of panes.slice(1)) p.setStretchFactor(SUB_PANE_SHARE);
    const intraday = data.timeframe === "5Min";
    c.applyOptions({
      timeScale: { timeVisible: intraday, tickMarkFormatter: tickLabel },
      localization: { timeFormatter: timeLabel },
    });
    c.timeScale().fitContent();
    candle.current = candles;
    last.current = s.candles.at(-1) ?? null;
  }, [data, show]);

  // A live price moves the latest candle in place; replacing the whole series per tick would redraw everything.
  useEffect(
    () =>
      onQuotes((quotes: Quote[]) => {
        const q = quotes.find((x) => x.key === key);
        if (!q || !candle.current || !data || data.source !== q.source) return;
        const time = liveTime(q.at, data.timeframe);
        const prev = last.current;
        const bar =
          prev && prev.time === time
            ? { ...prev, high: Math.max(prev.high, q.price), low: Math.min(prev.low, q.price), close: q.price }
            : { time, open: q.price, high: q.price, low: q.price, close: q.price };
        try {
          candle.current.update(bar as Parameters<ISeriesApi<"Candlestick">["update"]>[0]);
          last.current = bar;
        } catch {
          // A tick older than the last candle (clock skew between sources) is dropped.
        }
      }),
    [key, data],
  );

  if (!keys.length) {
    return (
      <div className="list">
        <div className="empty-row">Add a symbol to the watchlist to chart it.</div>
      </div>
    );
  }

  return (
    <section className="mk-chart">
      <div className="mk-chart-head">
        {!fixed && (
          <select className="pick" value={key ?? ""} aria-label="Symbol" onChange={(e) => setKey(e.target.value)}>
            {keys.map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        )}
        {row && !fixed && <Freshness quote={row.quote} missing={row.missing} />}
        <div className="seg">
          {RANGES.map((r) => (
            <button key={r} aria-pressed={range === r} onClick={() => setRange(r)}>
              {r}
            </button>
          ))}
        </div>
        <div className="seg">
          {TOGGLES.map((t) => (
            <button key={t.id} aria-pressed={show[t.id]} onClick={() => setShow({ ...show, [t.id]: !show[t.id] })}>
              {t.id !== "rsi14" && <span className="swatch" style={{ background: LINE_COLOURS[t.id] }} />}
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="mk-chart-box" ref={box} />
      {(error || data?.note) && <div className={error ? "err" : "mk-chart-note"}>{error ?? data?.note}</div>}
      {data && !data.bars.length && !error && !data.note && <div className="mk-chart-note">No bars for this range yet.</div>}
      <div className="mk-chart-legend">
        Volume below the price; <span style={{ color: UP }}>■</span> up day, <span style={{ color: DOWN }}>■</span> down day.
      </div>
    </section>
  );
}
