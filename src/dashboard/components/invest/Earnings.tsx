import { dateHeading, hourText, openSymbol, type EarningsView } from "../../simple";

export function Earnings({ spaceId, view }: { spaceId: string; view: EarningsView }) {
  if (!view.rows.length) {
    return (
      <section className="inv-empty">
        <p>No earnings in the next two weeks for your holdings or watchlists.</p>
        <p className="faint">{view.source}</p>
      </section>
    );
  }
  const days = [...new Set(view.rows.map((r) => r.date))];
  return (
    <section className="inv-earnings">
      {days.map((d) => (
        <div key={d} className="inv-day-group">
          <h3>{dateHeading(d)}</h3>
          <div className="inv-list">
            {view.rows
              .filter((r) => r.date === d)
              .map((r) => (
                <button key={r.key} className="inv-row-main inv-earn" onClick={() => openSymbol(spaceId, r.key)}>
                  <span className="inv-sym">
                    <b>{r.key}</b>
                    <span title={r.name}>{r.name || " "}</span>
                  </span>
                  <span className="inv-earn-when">{hourText(r.hour)}</span>
                  <span className="inv-earn-eps">{r.epsEstimate !== null ? `EPS est. ${r.epsEstimate.toFixed(2)}` : ""}</span>
                  <span className="inv-earn-tags">
                    {r.source === "you" && <span className="tag">your date</span>}
                    {r.held && <span className="tag held">you hold this</span>}
                  </span>
                </button>
              ))}
          </div>
        </div>
      ))}
      <p className="inv-foot faint">{view.source}</p>
    </section>
  );
}
