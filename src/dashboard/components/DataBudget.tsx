import { Clock } from "lucide-react";
import { put } from "../api";
import { absolute, relative } from "../format";
import { useBudget } from "../investing";

// One row per data source: calls today against its free limit, the last good answer and the last error in words.
export function DataBudget() {
  const b = useBudget();
  if (!b) return <div className="empty-row">Loading…</div>;
  const av = b.alphaVantage;
  return (
    <>
      <div className="list">
        {b.sources.map((s) => (
          <div key={s.source} className="item budget-row">
            <span className="who">{s.label}</span>
            <span className="t">
              <b>
                {s.callsToday} today{s.perDay ? ` of ${s.perDay.toLocaleString("en-US")}` : ""}
              </b>
              <span>
                {s.limit}
                {s.source === "alphavantage" && ` · planned after close: ${av.plan.length ? av.plan.join(", ") : "nothing yet"} · ${av.reserve} kept for you${av.deferred.length ? ` · deferred: ${av.deferred.join(", ")}` : ""}`}
              </span>
              {s.lastError && <span className="err">{s.lastError}</span>}
            </span>
            <span className="faint" title={s.lastOkAt ? absolute(s.lastOkAt) : undefined}>
              {s.lastOkAt ? `last OK ${relative(s.lastOkAt)}` : "not used yet"}
            </span>
          </div>
        ))}
      </div>
      <h3 className="sub-h">Scheduled jobs</h3>
      <div className="list">
        {b.jobs.length === 0 && <div className="empty-row">No jobs yet.</div>}
        {b.jobs.map((j) => (
          <div key={j.name} className="item budget-row">
            <span className="who">
              <Clock /> {j.name}
            </span>
            <span className="t">
              <span>{j.lastRunAt ? `last ran ${relative(j.lastRunAt)}` : "hasn't run yet"}</span>
              {j.lastError && <span className="err">{j.lastError}</span>}
            </span>
            <span className="faint">{j.nextAt ? `next ${absolute(j.nextAt)}` : ""}</span>
          </div>
        ))}
      </div>
      <label className="check set-check">
        <input type="checkbox" checked={b.edgar} onChange={(e) => void put("/api/investing/edgar", { on: e.target.checked })} />
        Cross-check P/E against SEC EDGAR filings (a few requests a month, US stocks only)
      </label>
    </>
  );
}
