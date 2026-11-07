import { Sparkles } from "lucide-react";
import { useState } from "react";
import type { MoneyView } from "../../../engine/money/summary";
import { post } from "../../api";
import { cadText, investPath, signedCadText } from "../../simple";
import { Markdown } from "../Markdown";

const monthFmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" });
export const monthText = (m: string) => monthFmt.format(Date.parse(`${m}-15T12:00:00Z`));
const shortFmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
export const shortDate = (d: string) => shortFmt.format(Date.parse(`${d}T12:00:00Z`));

type Ask = MoneyView["asks"][number];
export const isExplain = (a: Ask) => a.question.startsWith("Explain my month: ");

// Where the money went this month against last month. Every number here comes from the engine; Claude only puts
// them in words when Nakul asks.
export function MoneyRecap({ spaceId, view, onMonth }: { spaceId: string; view: MoneyView; onMonth: (m: string) => void }) {
  const [error, setError] = useState<string | null>(null);
  const r = view.recap;
  if (!r || !view.month) return null;
  const explains = view.asks.filter((a) => isExplain(a) && a.question === `Explain my month: ${monthText(r.month)}`);
  const asking = view.asks.find((a) => isExplain(a) && (a.status === "queued" || a.status === "running"));
  const answer = explains.find((a) => a.status === "done");
  const explain = async () => {
    const res = await post(`${investPath(spaceId)}/money/explain`, { month: r.month });
    setError(res.ok ? null : res.error);
  };
  const diff = r.before ? r.spent - r.before.spent : null;
  return (
    <section className="money-recap" aria-label="Monthly recap">
      <div className="money-recap-head">
        <select value={view.month} aria-label="Month" onChange={(e) => onMonth(e.target.value)}>
          {view.months.map((m) => (
            <option key={m} value={m}>
              {monthText(m)}
            </option>
          ))}
        </select>
        <span className="faint">
          Based on {r.basis.count} {r.basis.count === 1 ? "transaction" : "transactions"}, {shortDate(r.basis.from)} to {shortDate(r.basis.to)}
          {r.eTransfers.count > 0 && ` · ${cadText(r.eTransfers.total)} in e-transfers left out`}
        </span>
      </div>
      {view.coverLine && <p className="money-cover">{view.coverLine}</p>}
      <div className="money-hero">
        <div>
          <span className="money-hero-label">Spent</span>
          <b>{cadText(r.spent)}</b>
          {diff !== null && r.previous && (
            <span className={`money-delta ${diff > 0 ? "up" : "down"}`}>
              {signedCadText(diff)} vs {monthText(r.previous).split(" ")[0]}
            </span>
          )}
        </div>
        <div>
          <span className="money-hero-label" title="Pay, e-transfers received and interest.">Money in</span>
          <b>{cadText(r.income)}</b>
        </div>
        <div>
          <span className="money-hero-label">{r.net >= 0 ? "Left over" : "Short"}</span>
          <b>{cadText(Math.abs(r.net))}</b>
        </div>
      </div>
      {(r.refunds.count > 0 || r.moved.count > 0) && (
        <p className="money-aside">
          {[r.refunds.count > 0 && `Refunds ${cadText(r.refunds.total)}`, r.moved.count > 0 && `Moved between your accounts ${cadText(r.moved.total)}`].filter(Boolean).join(" · ")}
        </p>
      )}
      {(r.changes.length > 0 || r.notable.length > 0) && (
        <div className="money-recap-cols">
          {r.changes.length > 0 && (
            <div>
              <h4>Biggest changes</h4>
              <ul className="money-mini">
                {r.changes.map((c) => (
                  <li key={c.category}>
                    <span>{c.category}</span>
                    <span className={c.delta > 0 ? "up" : "down"}>{signedCadText(c.delta)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {r.notable.length > 0 && (
            <div>
              <h4>Notable charges</h4>
              <ul className="money-mini">
                {r.notable.map((n) => (
                  <li key={`${n.date}-${n.merchant}-${n.amount}`} title={n.why}>
                    <span>
                      {n.merchant} <span className="faint">· {shortDate(n.date)}</span>
                    </span>
                    <span>{cadText(n.amount)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {view.tie && <p className="money-tie">{view.tie} Facts, not advice.</p>}
      <div className="money-explain">
        {asking ? (
          <p className="sym-asking">Claude is putting your month into words…</p>
        ) : (
          <button className="btn" onClick={() => void explain()}>
            <Sparkles />
            {answer ? "Explain it again" : "Explain my month"}
          </button>
        )}
        {!asking && !answer && <span className="faint">Claude rephrases these numbers. It doesn't add any.</span>}
      </div>
      {answer && (
        <div className="money-explained">
          <Markdown text={answer.body} />
        </div>
      )}
      {error && <p className="err">{error}</p>}
    </section>
  );
}
