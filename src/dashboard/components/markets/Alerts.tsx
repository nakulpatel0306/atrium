import { BellPlus } from "lucide-react";
import { useState } from "react";
import { describeRule, type AlertRule } from "../../../engine/markets/labels";
import { del, patch, post } from "../../api";
import { absolute, relative } from "../../format";
import { etDateTimeText, type MarketsView } from "../../markets";

type Kind = AlertRule["kind"];
const KINDS: { kind: Kind; label: string }[] = [
  { kind: "price_above", label: "Price goes above" },
  { kind: "price_below", label: "Price goes below" },
  { kind: "pct_move", label: "Moves more than (% in a day)" },
  { kind: "rsi_below", label: "RSI drops below" },
  { kind: "rsi_above", label: "RSI rises above" },
  { kind: "cross_above_sma", label: "Crosses above its moving average" },
  { kind: "cross_below_sma", label: "Crosses below its moving average" },
];
const STATUS: Record<MarketsView["alerts"][number]["status"], string> = { armed: "watching", fired: "fired · waiting to re-arm", off: "off" };

function ruleFrom(kind: Kind, level: string, pct: string, period: string): AlertRule {
  if (kind === "price_above" || kind === "price_below") return { kind, level: Number(level) };
  if (kind === "pct_move") return { kind, pct: Number(pct) };
  if (kind === "rsi_below" || kind === "rsi_above") return { kind, level: Number(level), period: Number(period) };
  return { kind, period: Number(period) };
}

function NewAlert({ view }: { view: MarketsView }) {
  const keys = [...new Set([...view.watchlist.map((w) => w.key), ...view.holdings.map((h) => h.key)])];
  const [key, setKey] = useState(keys[0] ?? "");
  const [kind, setKind] = useState<Kind>("price_above");
  const [level, setLevel] = useState("");
  const [pct, setPct] = useState("5");
  const [period, setPeriod] = useState("14");
  const [note, setNote] = useState("");
  const [repeat, setRepeat] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const usesLevel = kind.startsWith("price") || kind.startsWith("rsi");
  const usesPeriod = kind.startsWith("rsi") || kind.startsWith("cross");

  const submit = async () => {
    const res = await post(`/api/markets/${encodeURIComponent(view.spaceId)}/alerts`, { key, rule: ruleFrom(kind, level, pct, period), note, repeat });
    if (!res.ok) return setError(res.error);
    setError(null);
    setLevel("");
    setNote("");
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
        <input className="mk-input" list="mk-alert-keys" value={key} onChange={(e) => setKey(e.target.value)} />
        <datalist id="mk-alert-keys">
          {keys.map((k) => (
            <option key={k} value={k} />
          ))}
        </datalist>
      </label>
      <label>
        When it
        <select
          className="pick"
          value={kind}
          onChange={(e) => {
            const k = e.target.value as Kind;
            setKind(k);
            setPeriod(k.startsWith("cross") ? "50" : "14");
          }}
        >
          {KINDS.map((k) => (
            <option key={k.kind} value={k.kind}>
              {k.label}
            </option>
          ))}
        </select>
      </label>
      {usesLevel && (
        <label>
          {kind.startsWith("rsi") ? "RSI level" : "Price"}
          <input className="mk-input" value={level} onChange={(e) => setLevel(e.target.value)} inputMode="decimal" placeholder={kind.startsWith("rsi") ? "30" : "200.00"} />
        </label>
      )}
      {kind === "pct_move" && (
        <label>
          Percent
          <input className="mk-input" value={pct} onChange={(e) => setPct(e.target.value)} inputMode="decimal" />
        </label>
      )}
      {usesPeriod && (
        <label>
          {kind.startsWith("rsi") ? "RSI period" : "SMA days"}
          <input className="mk-input" value={period} onChange={(e) => setPeriod(e.target.value)} inputMode="numeric" />
        </label>
      )}
      <label>
        Note (optional)
        <input className="mk-input wide" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why this matters to you" />
      </label>
      <label className="check">
        <input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} />
        Keep watching after it fires
      </label>
      <button className="btn p" type="submit" disabled={!key.trim()}>
        <BellPlus />
        Add alert
      </button>
      {error && <span className="err">{error}</span>}
    </form>
  );
}

export function Alerts({ view }: { view: MarketsView }) {
  const [open, setOpen] = useState<string | null>(null);
  const base = `/api/markets/${encodeURIComponent(view.spaceId)}/alerts`;
  return (
    <section>
      <h2>Alerts</h2>
      <p className="hint mk-lead">An alert puts one item in Needs you when its rule is met, then waits until the price moves 0.5% back before it can fire again.</p>
      <NewAlert view={view} />
      <div className="list">
        {view.alerts.length === 0 && <div className="empty-row">No alerts yet.</div>}
        {view.alerts.map((a) => (
          <div key={a.id} className="entry">
            <div className="item mk-row" role="button" tabIndex={0} onClick={() => setOpen(open === a.id ? null : a.id)} onKeyDown={(e) => e.key === "Enter" && setOpen(open === a.id ? null : a.id)}>
              <span className="sym">{a.key}</span>
              <span className="t">{describeRule(a.rule)}</span>
              <span className={`tag${a.status === "armed" ? " ok" : ""}`}>{STATUS[a.status]}</span>
              <span className="num faint">{a.lastFiredAt ? `fired ${etDateTimeText(a.lastFiredAt)}` : "never fired"}</span>
            </div>
            {open === a.id && (
              <div className="detail">
                {a.note && <pre>{a.note}</pre>}
                <div className="meta">
                  <span title={absolute(a.createdAt)}>Created {relative(a.createdAt)}</span>
                  <span>{a.repeat ? "Keeps watching after it fires" : "Turns off after it fires once"}</span>
                  {a.lastFiredAt && <span>Last fired {absolute(a.lastFiredAt)}</span>}
                </div>
                <div className="mk-form">
                  {a.status === "off" ? (
                    <button className="btn" onClick={() => void patch(`${base}/${a.id}`, { status: "armed" })}>
                      Turn on
                    </button>
                  ) : (
                    <button className="btn" onClick={() => void patch(`${base}/${a.id}`, { status: "off" })}>
                      Turn off
                    </button>
                  )}
                  <button className="btn danger" onClick={() => void del(`${base}/${a.id}`)}>
                    Delete
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
