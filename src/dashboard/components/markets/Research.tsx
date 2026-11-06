import { CalendarPlus, ExternalLink, Save, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { currencyOfKey } from "../../../engine/markets/labels";
import type { Sourced } from "../../../engine/markets/sourced";
import { post, put } from "../../api";
import { absolute, money } from "../../format";
import { investingPath, pctText, useResearch, type ResearchView } from "../../investing";
import type { MarketsView } from "../../markets";
import { Markdown } from "../Markdown";
import { AdviceTag } from "./AdviceTag";
import { PriceChart } from "./PriceChart";
import { SourceTag } from "./SourceTag";

const dayFmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" });
const dateText = (iso: string) => dayFmt.format(Date.parse(`${iso}T12:00:00Z`));
const HOURS: Record<string, string> = { amc: "after close", bmo: "before open", dmh: "during market hours" };

function Metrics({ r }: { r: ResearchView }) {
  const m = r.meta;
  const metrics: Sourced | null = m?.metricsAt ? { value: 0, source: `Finnhub · metrics ${new Date(m.metricsAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`, asOf: m.metricsAt, tone: "delayed" } : null;
  const year = r.closes.map((c) => c.close);
  const fromCloses = year.length >= 200;
  const high = fromCloses ? Math.max(...year) : (m?.high52 ?? null);
  const low = fromCloses ? Math.min(...year) : (m?.low52 ?? null);
  const price = r.price?.value ?? null;
  const pos = price !== null && high !== null && low !== null && high > low ? Math.min(1, Math.max(0, (price - low) / (high - low))) : null;
  const ccy = currencyOfKey(r.key);
  return (
    <div className="rs-grid">
      <div className="rs-cell">
        <span className="faint">P/E (trailing)</span>
        <b>{m?.pe != null ? m.pe.toFixed(1) : "n/a"}</b>
        <SourceTag s={m?.pe != null ? metrics : null} missing="Needs a Finnhub key" />
        {r.edgar && (
          <span className={r.edgar.differs ? "err" : "faint"}>
            EDGAR P/E {r.edgar.edgarPe?.toFixed(1) ?? "n/a"}
            {r.edgar.differs ? " · differs by more than 10%" : ""}
          </span>
        )}
      </div>
      <div className="rs-cell">
        <span className="faint">52-week range</span>
        <b>{low !== null && high !== null ? `${money(low, ccy)} – ${money(high, ccy)}` : "n/a"}</b>
        {pos !== null && (
          <span className="range-track" title={`${pctText(pos * 100)} of the way from the low to the high`}>
            <span className="range-dot" style={{ left: `${pos * 100}%` }} />
          </span>
        )}
        <span className="faint">{fromCloses ? "Atrium's stored closes" : m?.high52 != null ? "Finnhub · metrics" : "Not enough history yet"}</span>
      </div>
      <div className="rs-cell">
        <span className="faint">Dividend yield</span>
        <b>{m?.divYield != null ? `${m.divYield.toFixed(2)}%` : "n/a"}</b>
        <SourceTag s={m?.divYield != null ? metrics : null} missing="None reported" />
      </div>
      <div className="rs-cell">
        <span className="faint">Sector · country</span>
        <b>
          {m?.sector ?? "Unknown"} · {m?.country ?? "Unknown"}
        </b>
        <span className="faint">{m?.sectorSource ?? "No source yet"}</span>
      </div>
    </div>
  );
}

function Earnings({ spaceId, r }: { spaceId: string; r: ResearchView }) {
  const [date, setDate] = useState("");
  const [hour, setHour] = useState("amc");
  const [error, setError] = useState<string | null>(null);
  return (
    <section>
      <h2>Upcoming earnings</h2>
      <div className="list">
        {r.earnings.length === 0 && <div className="empty-row">No earnings date known. Add it if you know it (Finnhub's free calendar covers US stocks only).</div>}
        {r.earnings.map((e) => (
          <div key={e.date} className="item mk-row">
            <span className="t">
              <b>{dateText(e.date)}</b>
              {e.hour && <span>{HOURS[e.hour] ?? e.hour}</span>}
            </span>
            <span className="num">{e.epsEstimate !== null ? `EPS est. ${e.epsEstimate}` : ""}</span>
            <span className={`fresh ${e.source === "you" ? "live" : "delayed"}`}>{e.source === "you" ? "Entered by you" : "Finnhub · earnings calendar"}</span>
          </div>
        ))}
        <form
          className="mk-form tfsa-form"
          onSubmit={(e) => {
            e.preventDefault();
            void post(`${investingPath(spaceId)}/research/${encodeURIComponent(r.key)}/earnings`, { date, hour }).then((res) => setError(res.ok ? null : res.error));
          }}
        >
          <label>
            Add a date
            <input className="mk-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label>
            When
            <select className="pick" value={hour} onChange={(e) => setHour(e.target.value)}>
              <option value="amc">After close</option>
              <option value="bmo">Before open</option>
            </select>
          </label>
          <button className="btn" type="submit" disabled={!date}>
            <CalendarPlus />
            Add date
          </button>
          {error && <span className="err">{error}</span>}
        </form>
      </div>
    </section>
  );
}

function Notes({ spaceId, r }: { spaceId: string; r: ResearchView }) {
  const [thesis, setThesis] = useState(r.notes.thesis);
  const [notes, setNotes] = useState(r.notes.notes);
  const [msg, setMsg] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => {
    setThesis(r.notes.thesis);
    setNotes(r.notes.notes);
  }, [r.key, r.notes.updatedAt]);
  const base = `${investingPath(spaceId)}/research/${encodeURIComponent(r.key)}`;
  const save = (patch: { thesis?: string; notes?: string }) => void put(`${base}/notes`, patch).then((res) => setMsg(res.ok ? "Saved." : res.error));
  const draft = r.writeups.find((w) => w.kind === "thesis_draft");
  return (
    <section>
      <h2>Thesis and notes</h2>
      <div className="list rs-notes">
        <label>
          Your thesis
          <textarea className="mk-input" rows={4} value={thesis} onChange={(e) => setThesis(e.target.value)} placeholder="Why you own or watch it, and what would change your mind." />
        </label>
        <div className="mk-form">
          <button className="btn" onClick={() => save({ thesis })}>
            <Save />
            Save thesis
          </button>
          <button className="btn" disabled={r.drafting} onClick={() => void post(`${base}/thesis-draft`).then((res) => setMsg(res.ok ? "Claude is drafting; it'll show here." : res.error))}>
            <Sparkles />
            {r.drafting ? "Claude is drafting…" : "Ask Claude to draft"}
          </button>
          {msg && <span className={msg.endsWith(".") && !msg.startsWith("Claude is already") ? "ok-line" : "err"}>{msg}</span>}
        </div>
        {draft && dismissed !== draft.id && (
          <div className="rs-writeup">
            <div className="rs-writeup-head">
              <b>Claude's draft</b>
              <span className="faint">{dateText(draft.forDate)}</span>
              <AdviceTag />
            </div>
            <Markdown text={draft.body} />
            <div className="mk-form">
              <button className="btn" onClick={() => setThesis(draft.body.replace(/\n*Analysis, not advice\.$/, ""))}>
                Use this draft
              </button>
              <button className="btn" onClick={() => setDismissed(draft.id)}>
                Dismiss
              </button>
            </div>
          </div>
        )}
        <label>
          Notes
          <textarea className="mk-input" rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Earnings call takeaways, things to check." />
        </label>
        <div className="mk-form">
          <button className="btn" onClick={() => save({ notes })}>
            <Save />
            Save notes
          </button>
          {r.notes.updatedAt && <span className="faint">saved {absolute(r.notes.updatedAt)}</span>}
        </div>
      </div>
    </section>
  );
}

export function Research({ spaceId, view, initialKey }: { spaceId: string; view: MarketsView; initialKey: string | null }) {
  const keys = [...new Set([...view.holdings.map((h) => h.key), ...view.watchlist.map((w) => w.key)])];
  const [key, setKey] = useState<string | null>(initialKey ?? keys[0] ?? null);
  const r = useResearch(spaceId, key);
  if (!key) return <div className="empty-row">Add a symbol to the watchlist to research it.</div>;
  const checks = r?.writeups.filter((w) => w.kind === "thesis_check") ?? [];
  return (
    <div className="research">
      <div className="mk-form">
        <label>
          Symbol
          <select className="pick" value={key} onChange={(e) => setKey(e.target.value)}>
            {keys.map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>
      </div>
      {!r || r.key !== key ? (
        <div className="empty-row">Loading {key}…</div>
      ) : (
        <>
          <section className="health-top rs-head">
            <div className="health-total">
              <span className="faint">
                {r.name} · {r.key}
              </span>
              <span className="big">{r.price ? money(r.price.value, currencyOfKey(r.key)) : "—"}</span>
              {r.estimate && (
                <span className="faint">
                  ≈ {money(r.estimate.value, "CAD")} now <SourceTag s={r.estimate} />
                </span>
              )}
            </div>
            <SourceTag s={r.price} missing="No price yet" />
          </section>
          <PriceChart key={key} view={view} initialKey={key} fixed />
          <Metrics r={r} />
          {checks.map((w) => (
            <section key={w.id}>
              <div className="rs-writeup check">
                <div className="rs-writeup-head">
                  <b>Thesis check before earnings on {dateText(w.forDate)}</b>
                  <AdviceTag />
                </div>
                <Markdown text={w.body} />
              </div>
            </section>
          ))}
          <Earnings spaceId={spaceId} r={r} />
          <section>
            <h2>Dividends</h2>
            <div className="list">
              {r.dividends.length === 0 && <div className="empty-row">No dividends recorded{r.key.endsWith(".TO") ? " (no free source for Canadian distributions yet)" : ""}.</div>}
              {r.dividends.map((d) => (
                <div key={d.exDate} className="item mk-row">
                  <span className="t">{dateText(d.exDate)}</span>
                  <span className="num">{money(d.amount, currencyOfKey(r.key))}</span>
                  <span className="fresh live">Tiingo dividends</span>
                </div>
              ))}
              {r.withholding && <div className="empty-row">{r.withholding}</div>}
            </div>
          </section>
          <section>
            <h2>News</h2>
            <div className="list">
              {r.news.length === 0 && <div className="empty-row">No headlines stored yet. News arrives hourly during the session once Finnhub has a key.</div>}
              {r.news.map((n) => (
                <a key={n.url} className="item mk-row news-row" href={n.url} target="_blank" rel="noreferrer noopener">
                  <span className="t">{n.headline}</span>
                  <span className="faint">
                    {n.source} · {absolute(n.at)}
                  </span>
                  <ExternalLink />
                </a>
              ))}
            </div>
          </section>
          {r.lookThrough && (
            <section>
              <h2>
                What it holds
                <span className="h2-acts">
                  {r.lookThrough.sources.map((s) => (
                    <SourceTag key={s.value} s={s} />
                  ))}
                </span>
              </h2>
              <div className="list">
                {r.lookThrough.exposures.slice(0, 15).map((e) => (
                  <div key={e.company} className="item mk-row">
                    <span className="sym">{e.ticker ?? "—"}</span>
                    <span className="t">
                      {e.name}
                      {e.via.length > 1 && <span>through {e.via.slice(1).join(" → ")}</span>}
                    </span>
                    <span className="num">{pctText(e.weight * 100)}</span>
                  </div>
                ))}
                <div className="empty-row">
                  {pctText(r.lookThrough.coverage * 100)} matched to companies.
                  {r.lookThrough.note ? ` ${r.lookThrough.note}` : ""}
                  {r.lookThrough.unavailable.map((u) => ` Breakdown unavailable for ${u.fund}: ${u.reason}.`).join("")}
                </div>
              </div>
            </section>
          )}
          {!r.lookThrough && r.meta?.kind === "etf" && <div className="empty-row">Breakdown unavailable: no holdings file yet.</div>}
          <Notes spaceId={spaceId} r={r} />
        </>
      )}
    </div>
  );
}
