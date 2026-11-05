import { FlaskConical, Pause, Play, Send } from "lucide-react";
import { useState } from "react";
import type { BacktestResult, BacktestTemplate } from "../../../engine/markets/backtest";
import { describeTemplate } from "../../../engine/markets/backtest";
import type { ChartRange } from "../../../engine/markets/data";
import { patch, post } from "../../api";
import { absolute, money, relative } from "../../format";
import type { MarketsView } from "../../markets";

const CADENCE = { open: "at 9:45 AM ET", hourly: "hourly, 10 AM–3 PM ET", close: "at 3:45 PM ET" } as const;
const STATUS = { draft: "waiting for your approval", active: "running", paused: "paused", rejected: "not approved" } as const;
const TEMPLATES: { id: string; t: BacktestTemplate }[] = [
  { id: "sma", t: { kind: "sma_cross", fast: 20, slow: 50 } },
  { id: "rsi", t: { kind: "rsi_revert", period: 14, buyBelow: 30, sellAbove: 70 } },
  { id: "hold", t: { kind: "buy_hold" } },
];

const backtestLine = (key: string, t: BacktestTemplate, range: ChartRange, r: BacktestResult) =>
  `Backtest ${key} ${describeTemplate(t)} (${range}): ${r.returnPct.toFixed(1)}% vs buy-and-hold ${r.buyHoldReturnPct.toFixed(1)}%, max drawdown ${r.maxDrawdownPct.toFixed(1)}%, ${r.trades.length} trades.`;

function NewStrategy({ view, onDone }: { view: MarketsView; onDone: () => void }) {
  const [f, setF] = useState({ name: "", rules: "", symbols: "", cadence: "open", maxPositionValue: "2000", maxTradesPerDay: "3" });
  const [tpl, setTpl] = useState("sma");
  const [range, setRange] = useState<ChartRange>("1Y");
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const symbols = f.symbols.split(/[\s,]+/).filter(Boolean);
  const base = `/api/markets/${encodeURIComponent(view.spaceId)}`;

  const runBacktest = async () => {
    const t = TEMPLATES.find((x) => x.id === tpl)!.t;
    const key = symbols[0];
    if (!key) return setError("Add a symbol to backtest first.");
    const res = await post<BacktestResult>(`${base}/backtest`, { key, template: t, range });
    if (!res.ok) return setError(res.error);
    setError(null);
    setResult(backtestLine(key, t, range, res.data));
  };
  const send = async () => {
    const res = await post(`${base}/strategies`, {
      name: f.name,
      rules: f.rules,
      symbols,
      cadence: f.cadence,
      maxPositionValue: Number(f.maxPositionValue),
      maxTradesPerDay: Number(f.maxTradesPerDay),
      backtestSummary: result ?? undefined,
    });
    if (!res.ok) return setError(res.error);
    onDone();
  };

  return (
    <div className="mk-form boxed col">
      <div className="mk-form">
        <label>
          Name
          <input className="mk-input" value={f.name} onChange={set("name")} placeholder="Momentum" autoFocus />
        </label>
        <label>
          Symbols
          <input className="mk-input" value={f.symbols} onChange={set("symbols")} placeholder="AAPL, MSFT" />
        </label>
        <label>
          Runs
          <select className="pick" value={f.cadence} onChange={set("cadence")}>
            <option value="open">At the open (9:45 AM ET)</option>
            <option value="hourly">Hourly</option>
            <option value="close">Near the close (3:45 PM ET)</option>
          </select>
        </label>
        <label>
          Max per position ($)
          <input className="mk-input" value={f.maxPositionValue} onChange={set("maxPositionValue")} inputMode="decimal" />
        </label>
        <label>
          Max trades a day
          <input className="mk-input" value={f.maxTradesPerDay} onChange={set("maxTradesPerDay")} inputMode="numeric" />
        </label>
      </div>
      <label>
        Rules the agent follows
        <textarea className="mk-input mk-rules" rows={3} value={f.rules} onChange={set("rules")} placeholder="Buy when the price closes above its 20-day average; sell when it closes below." />
      </label>
      <div className="mk-form">
        <select className="pick" value={tpl} onChange={(e) => setTpl(e.target.value)} aria-label="Backtest template">
          {TEMPLATES.map((x) => (
            <option key={x.id} value={x.id}>
              {describeTemplate(x.t)}
            </option>
          ))}
        </select>
        <div className="seg">
          {(["1M", "3M", "6M", "1Y"] as const).map((r) => (
            <button key={r} type="button" aria-pressed={range === r} onClick={() => setRange(r)}>
              {r}
            </button>
          ))}
        </div>
        <button className="btn" type="button" onClick={() => void runBacktest()}>
          <FlaskConical />
          Backtest first
        </button>
        <button className="btn p" type="button" onClick={() => void send()}>
          <Send />
          Send for approval
        </button>
        <button className="btn" type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
      {result && <div className="mk-chart-note">{result}</div>}
      {error && <div className="err">{error}</div>}
      <div className="hint">Strategies run against the paper account only. Atrium never places real trades.</div>
    </div>
  );
}

export function Strategies({ view }: { view: MarketsView }) {
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const base = `/api/markets/${encodeURIComponent(view.spaceId)}/strategies`;
  return (
    <section>
      <h2>
        Paper strategies
        <span className="h2-acts">
          <button className="btn" onClick={() => setAdding(!adding)}>
            New strategy
          </button>
        </span>
      </h2>
      {adding && <NewStrategy view={view} onDone={() => setAdding(false)} />}
      <div className="list">
        {view.strategies.length === 0 && <div className="empty-row">No strategies. An approved strategy lets Claude place paper trades on a schedule, within your limits.</div>}
        {view.strategies.map((s) => (
          <div key={s.id} className="entry">
            <div className="item mk-row" role="button" tabIndex={0} onClick={() => setOpen(open === s.id ? null : s.id)} onKeyDown={(e) => e.key === "Enter" && setOpen(open === s.id ? null : s.id)}>
              <span className="t">
                <b>{s.name}</b>
                <span>
                  {s.symbols.join(", ")} · {CADENCE[s.cadence]} · ≤ {money(s.maxPositionValue, "USD")} a position · ≤ {s.maxTradesPerDay} trades a day
                </span>
              </span>
              <span className={`tag${s.status === "active" ? " ok" : s.status === "rejected" ? " bad" : ""}`}>{STATUS[s.status]}</span>
              <span className="num faint">{s.lastRunAt ? `ran ${relative(s.lastRunAt)}` : "hasn't run"}</span>
              {(s.status === "active" || s.status === "paused") && (
                <button
                  className="btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    void patch(`${base}/${s.id}`, { paused: s.status === "active" });
                  }}
                >
                  {s.status === "active" ? <Pause /> : <Play />}
                  {s.status === "active" ? "Pause" : "Resume"}
                </button>
              )}
            </div>
            {open === s.id && (
              <div className="detail">
                <pre>{s.rules}</pre>
                <div className="meta">
                  <span title={absolute(s.createdAt)}>Proposed {relative(s.createdAt)}</span>
                  {s.lastRunAt && <span>Last run {absolute(s.lastRunAt)}</span>}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
