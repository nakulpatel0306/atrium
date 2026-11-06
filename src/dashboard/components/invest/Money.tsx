import { Sparkles, Upload } from "lucide-react";
import { useState } from "react";
import type { MoneyView } from "../../../engine/money/summary";
import { post, useEngineState, useFetched } from "../../api";
import { relative } from "../../format";
import { cadText, dateHeading, investPath } from "../../simple";
import { Markdown } from "../Markdown";
import { WhatItMade } from "../WhatItMade";
import { AdviceTag } from "../markets/AdviceTag";
import { MoneyImport } from "./MoneyImport";
import { MoneyRules } from "./MoneyRules";

export type MoneyPage = MoneyView & { starters: string[] };

const monthFmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" });
const monthText = (m: string) => monthFmt.format(Date.parse(`${m}-15T12:00:00Z`));

function Ask({ spaceId, view, now }: { spaceId: string; view: MoneyPage; now: number }) {
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const open = view.asks.find((a) => a.status === "queued" || a.status === "running");
  const ask = async (question: string) => {
    const res = await post(`${investPath(spaceId)}/money/ask`, { question });
    setError(res.ok ? null : res.error);
    if (res.ok) setQ("");
  };
  return (
    <section className="money-ask">
      <h3>Ask about my money</h3>
      {open ? (
        <p className="sym-asking">
          Claude is looking at your money… <a href={`/space/${spaceId}?task=${open.taskId}`}>Open the task</a>
        </p>
      ) : (
        <>
          <form
            className="sym-ask-form"
            onSubmit={(e) => {
              e.preventDefault();
              void ask(q);
            }}
          >
            <input value={q} maxLength={500} placeholder="Ask anything about your spending, dividends or TFSA." aria-label="Question about your money" onChange={(e) => setQ(e.target.value)} />
            <button className="btn p" type="submit" disabled={!q.trim()}>
              <Sparkles />
              Ask Claude
            </button>
          </form>
          <div className="money-starters">
            {view.starters.map((s) => (
              <button key={s} className="wl-chip" onClick={() => void ask(s)}>
                {s}
              </button>
            ))}
          </div>
        </>
      )}
      <p className="hint">Claude reads a short summary of what you import here and your holdings. Nothing else leaves this Mac.</p>
      {error && <p className="err">{error}</p>}
      {view.asks
        .filter((a) => a.status === "done" || a.status === "failed")
        .map((a) => (
          <article key={a.id} className="sym-answer">
            <header>
              <b>{a.question || "Your question"}</b>
              <span className="faint">{relative(a.createdAt, now)}</span>
            </header>
            <Markdown text={a.body} />
            <AdviceTag />
            {a.taskId && (
              <div className="ask-made">
                <WhatItMade taskId={a.taskId} spaceId={spaceId} spaceKind="markets" />
              </div>
            )}
          </article>
        ))}
    </section>
  );
}

function Month({ view, onMonth }: { view: MoneyPage; onMonth: (m: string) => void }) {
  if (!view.month) return <p className="faint">No bank or card transactions yet.</p>;
  const max = Math.max(1, ...view.spending.map((s) => s.amount));
  return (
    <>
      <div className="money-month-head">
        <select value={view.month} aria-label="Month" onChange={(e) => onMonth(e.target.value)}>
          {view.months.map((m) => (
            <option key={m} value={m}>
              {monthText(m)}
            </option>
          ))}
        </select>
        <span>
          Spent <b>{cadText(view.spent)}</b> · Money in <b>{cadText(view.income)}</b>
        </span>
      </div>
      {view.spending.length === 0 ? (
        <p className="faint">No spending in {monthText(view.month)}.</p>
      ) : (
        <ul className="money-cats">
          {view.spending.map((s) => (
            <li key={s.category}>
              <span className="money-cat">{s.category}</span>
              <span className="money-bar" aria-hidden>
                <span style={{ width: `${(s.amount / max) * 100}%` }} />
              </span>
              <span className="money-amt">{cadText(s.amount)}</span>
              <span className="faint money-count">{s.count === 1 ? "1 charge" : `${s.count} charges`}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function Recurring({ view }: { view: MoneyPage }) {
  if (!view.recurring.length) return <p className="faint">No regular monthly charges found yet.</p>;
  return (
    <ul className="money-list">
      {view.recurring.map((r) => (
        <li key={r.merchant}>
          <b>{r.merchant}</b>
          <span>{cadText(r.amount)} a month</span>
          <span className="faint">
            {r.count} so far · next around {dateHeading(r.next)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Unusual({ view }: { view: MoneyPage }) {
  if (!view.unusual.length) return <p className="faint">Nothing unusual in the last 90 days.</p>;
  return (
    <ul className="money-list">
      {view.unusual.map((u) => (
        <li key={`${u.date}-${u.merchant}-${u.amount}`}>
          <b>{u.merchant}</b>
          <span>
            {cadText(u.amount)} · {dateHeading(u.date)}
          </span>
          <span className="faint">{u.reason}</span>
        </li>
      ))}
    </ul>
  );
}

function Wealthsimple({ view }: { view: MoneyPage }) {
  if (!view.ws.length) return <p className="faint">Import a Wealthsimple activity export to see deposits, dividends and fees.</p>;
  const us = (n: number) => `US$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  // CAD and USD activity stay apart; a year with only US trades shows just the US amount.
  const both = (c: number, u: number) => (u && !c ? us(u) : u ? `${cadText(c)} + ${us(u)}` : cadText(c));
  return (
    <div className="money-ws">
      {view.ws.slice(0, 3).map((y) => (
        <dl key={y.year} className="sym-stats">
          <div className="money-year">
            <dt>Year</dt>
            <dd>{y.year}</dd>
          </div>
          <div>
            <dt>Deposits</dt>
            <dd>{cadText(y.deposits)}</dd>
          </div>
          <div>
            <dt>Into a TFSA</dt>
            <dd>{cadText(y.tfsaDeposits)}</dd>
          </div>
          <div>
            <dt>Dividends</dt>
            <dd>
              {both(y.dividends, y.usd.dividends)}
            </dd>
          </div>
          <div>
            <dt>Withdrawals</dt>
            <dd>{cadText(y.withdrawals)}</dd>
          </div>
          <div>
            <dt>Fees</dt>
            <dd>{cadText(y.fees)}</dd>
          </div>
          <div>
            <dt>Bought</dt>
            <dd>
              {both(y.buys, y.usd.buys)}
            </dd>
          </div>
          <div>
            <dt>Sold</dt>
            <dd>
              {both(y.sells, y.usd.sells)}
            </dd>
          </div>
        </dl>
      ))}
    </div>
  );
}

export function MoneyBody({ spaceId, view, now = Date.now(), onMonth = () => {} }: { spaceId: string; view: MoneyPage; now?: number; onMonth?: (m: string) => void }) {
  const [importing, setImporting] = useState(false);
  const [rules, setRules] = useState(false);
  return (
    <div className="money">
      <Ask spaceId={spaceId} view={view} now={now} />
      <div className="money-bar-row">
        <button className="btn" onClick={() => setImporting(!importing)} aria-expanded={importing}>
          <Upload />
          Import a bank, card or Wealthsimple file
        </button>
        <span className="faint">
          {view.counts.bank} bank and card {view.counts.bank === 1 ? "transaction" : "transactions"} · {view.counts.wealthsimple} Wealthsimple {view.counts.wealthsimple === 1 ? "entry" : "entries"}
        </span>
      </div>
      {importing && <MoneyImport spaceId={spaceId} onClose={() => setImporting(false)} />}
      <div className="sym-cols">
        <div>
          <section>
            <h3>Spending by category</h3>
            <Month view={view} onMonth={onMonth} />
          </section>
          <section>
            <h3>Wealthsimple</h3>
            <Wealthsimple view={view} />
          </section>
        </div>
        <div>
          <section>
            <h3>Recurring charges</h3>
            <Recurring view={view} />
          </section>
          <section>
            <h3>Worth a look</h3>
            <Unusual view={view} />
          </section>
        </div>
      </div>
      <p className="hint money-foot">
        Categories come from {view.rules} simple {view.rules === 1 ? "rule" : "rules"} on this Mac.{" "}
        <button className="btn link" onClick={() => setRules(!rules)}>
          {rules ? "Hide rules" : "Edit rules"}
        </button>
      </p>
      {rules && <MoneyRules spaceId={spaceId} />}
    </div>
  );
}

export function Money({ spaceId }: { spaceId: string }) {
  const [month, setMonth] = useState<string | null>(null);
  const view = useFetched<MoneyPage>(`${investPath(spaceId)}/money${month ? `?month=${month}` : ""}`, useEngineState());
  if (!view) return <div className="inv-loading">Loading…</div>;
  return <MoneyBody spaceId={spaceId} view={view} onMonth={setMonth} />;
}
