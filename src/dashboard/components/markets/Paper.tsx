import { RotateCcw } from "lucide-react";
import { useState } from "react";
import { post } from "../../api";
import { agentName } from "../../agents";
import { absolute, money } from "../../format";
import { etClockText, type MarketsView } from "../../markets";
import { Strategies } from "./Strategies";

type Fill = MarketsView["paper"]["fills"][number];

const signed = (n: number) => <span className={n >= 0 ? "up" : "down"}>{`${n >= 0 ? "+" : "−"}${money(Math.abs(n), "USD")}`}</span>;

function OrderForm({ view }: { view: MarketsView }) {
  const [f, setF] = useState({ symbol: "", side: "buy", qty: "", reasoning: "" });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = async () => {
    const res = await post<{ fill: Fill }>(`/api/markets/${encodeURIComponent(view.spaceId)}/paper/orders`, { ...f, qty: Number(f.qty) });
    if (!res.ok) return setMsg({ ok: false, text: res.error });
    setMsg({ ok: true, text: `Filled: ${res.data.fill.side} ${res.data.fill.qty} ${res.data.fill.symbol} @ ${money(res.data.fill.price, "USD")}` });
    setF({ ...f, qty: "", reasoning: "" });
  };
  return (
    <form
      className="mk-form boxed"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label>
        Symbol
        <input className="mk-input" value={f.symbol} onChange={set("symbol")} placeholder="AAPL" />
      </label>
      <label>
        Side
        <select className="pick" value={f.side} onChange={set("side")}>
          <option value="buy">Buy</option>
          <option value="sell">Sell</option>
        </select>
      </label>
      <label>
        Shares
        <input className="mk-input" value={f.qty} onChange={set("qty")} inputMode="decimal" />
      </label>
      <label>
        Why (kept with the fill)
        <input className="mk-input wide" value={f.reasoning} onChange={set("reasoning")} placeholder="What you expect and why" />
      </label>
      <button className="btn p" type="submit" disabled={!f.symbol.trim() || !f.qty}>
        Place paper order
      </button>
      {msg && <span className={msg.ok ? "ok-line" : "err"}>{msg.text}</span>}
    </form>
  );
}

function FillRow({ fill, view }: { fill: Fill; view: MarketsView }) {
  const [open, setOpen] = useState(false);
  const strategy = fill.strategyId ? view.strategies.find((s) => s.id === fill.strategyId) : undefined;
  return (
    <div className="entry">
      <div className="item mk-row" role="button" tabIndex={0} onClick={() => setOpen(!open)} onKeyDown={(e) => e.key === "Enter" && setOpen(!open)}>
        <span className="t">
          <b className={fill.side === "buy" ? "up" : "down"}>{fill.side}</b> {fill.qty} {fill.symbol} @ {money(fill.price, "USD")} · {fill.actor === "you" ? "You" : agentName(fill.actor)}
          {strategy && ` · Strategy "${strategy.name}"`} · {etClockText(fill.createdAt)}
        </span>
      </div>
      {open && (
        <div className="detail">
          <pre>{fill.reasoning}</pre>
          <div className="meta">
            <span>
              Price from {fill.source === "demo" ? "demo data" : fill.source} at {absolute(fill.quoteAt)}
            </span>
            <span>Filled {absolute(fill.createdAt)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export function Paper({ view }: { view: MarketsView }) {
  const p = view.paper;
  const [resetting, setResetting] = useState(false);
  const [cash, setCash] = useState(String(p.startingCash));
  const [error, setError] = useState<string | null>(null);
  const reset = async () => {
    const res = await post(`/api/markets/${encodeURIComponent(view.spaceId)}/paper/reset`, { startingCash: Number(cash) });
    if (!res.ok) return setError(res.error);
    setError(null);
    setResetting(false);
  };
  return (
    <>
      <section>
        <h2>
          Paper account
          <span className="h2-acts">
            <button className="btn" onClick={() => setResetting(!resetting)}>
              <RotateCcw />
              Reset
            </button>
          </span>
        </h2>
        <div className="mk-cards">
          <div className="mk-card">
            <span>Equity</span>
            <b>{money(p.equity, "USD")}</b>
          </div>
          <div className="mk-card">
            <span>Cash</span>
            <b>{money(p.cash, "USD")}</b>
          </div>
          <div className="mk-card">
            <span>Today</span>
            <b>{signed(p.dayPnl)}</b>
          </div>
          <div className="mk-card">
            <span>Since start</span>
            <b>{signed(p.totalPnl)}</b>
          </div>
          <div className="mk-card">
            <span>Started with</span>
            <b>{money(p.startingCash, "USD")}</b>
          </div>
        </div>
        {resetting && (
          <form
            className="mk-form boxed"
            onSubmit={(e) => {
              e.preventDefault();
              void reset();
            }}
          >
            <span className="hint">Start over with fresh paper cash? Past fills stay in the log but stop counting.</span>
            <label>
              Starting cash ($)
              <input className="mk-input" value={cash} onChange={(e) => setCash(e.target.value)} inputMode="decimal" />
            </label>
            <button className="btn danger" type="submit">
              Reset paper account
            </button>
            <button className="btn" type="button" onClick={() => setResetting(false)}>
              Cancel
            </button>
            {error && <span className="err">{error}</span>}
          </form>
        )}
        <div className="list">
          <div className="mk-row mk-cols">
            <span className="sym">Symbol</span>
            <span className="t" />
            <span className="num">Shares</span>
            <span className="num">Avg cost</span>
            <span className="num">Last</span>
            <span className="num">Value</span>
            <span className="num day">Unrealized</span>
          </div>
          {p.positions.length === 0 && <div className="empty-row">No paper positions. US stocks fill at the last price while the market is open.</div>}
          {p.positions.map((x) => (
            <div key={x.symbol} className="item mk-row">
              <span className="sym">{x.symbol}</span>
              <span className="t" />
              <span className="num">{x.qty}</span>
              <span className="num">{money(x.avgCost, "USD")}</span>
              <span className="num">{x.last === null ? "—" : money(x.last, "USD")}</span>
              <span className="num">{x.marketValue === null ? "—" : money(x.marketValue, "USD")}</span>
              <span className="num day">{x.unrealized === null ? "—" : signed(x.unrealized)}</span>
            </div>
          ))}
        </div>
      </section>
      <section>
        <h2>New paper order</h2>
        <OrderForm view={view} />
      </section>
      <section>
        <h2>Fills</h2>
        <div className="list">
          {p.fills.length === 0 && <div className="empty-row">No fills yet.</div>}
          {p.fills.map((f) => (
            <FillRow key={f.id} fill={f} view={view} />
          ))}
        </div>
      </section>
      <Strategies view={view} />
    </>
  );
}
