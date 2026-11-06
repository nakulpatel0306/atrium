import { useState } from "react";
import { describeRule } from "../../../engine/markets/labels";
import type { Alert } from "../../../engine/markets/alerts";
import { del, patch } from "../../api";
import { openSymbol } from "../../simple";

const indicator = (a: Alert) => a.rule.kind.startsWith("rsi") || a.rule.kind.startsWith("cross");

export function AlertsSimple({ spaceId, alerts, advanced }: { spaceId: string; alerts: Alert[]; advanced: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const shown = advanced ? alerts : alerts.filter((a) => !indicator(a));
  const paused = alerts.length - shown.length;
  const path = (id: string) => `/api/markets/${encodeURIComponent(spaceId)}/alerts/${encodeURIComponent(id)}`;
  const toggle = async (a: Alert) => {
    const res = await patch(path(a.id), { status: a.status === "off" ? "armed" : "off" });
    setError(res.ok ? null : res.error);
  };
  const remove = async (a: Alert) => {
    const res = await del(path(a.id));
    setError(res.ok ? null : res.error);
  };
  return (
    <section className="inv-alerts">
      <p className="hint">Set price alerts from a symbol's page.</p>
      {shown.length === 0 ? (
        <div className="inv-empty">
          <p>No alerts yet.</p>
        </div>
      ) : (
        <div className="inv-list">
          {shown.map((a) => (
            <div key={a.id} className="inv-row inv-alert">
              <button className="inv-row-main" onClick={() => openSymbol(spaceId, a.key)}>
                <span className="inv-sym">
                  <b>{a.key}</b>
                  <span>{describeRule(a.rule, a.key)}</span>
                </span>
                {a.note && <span className="faint inv-alert-note">{a.note}</span>}
                <span className={`tag status ${a.status}`}>{a.status}</span>
              </button>
              <span className="inv-row-acts">
                <button className="btn" onClick={() => void toggle(a)}>
                  {a.status === "off" ? "Turn on" : "Turn off"}
                </button>
                <button className="btn" onClick={() => void remove(a)}>
                  Delete
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
      {paused > 0 && (
        <p className="faint inv-paused">
          {paused === 1 ? "1 indicator alert is paused." : `${paused} indicator alerts are paused.`} Turn on Advanced tools to see them.
        </p>
      )}
      {error && <p className="err">{error}</p>}
    </section>
  );
}
