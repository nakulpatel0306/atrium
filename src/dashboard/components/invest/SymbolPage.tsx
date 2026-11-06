import { ArrowLeft, Bell, Check, ListPlus, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { currencyOfKey, describeRule, type AlertRule } from "../../../engine/markets/labels";
import { del, post, put, useEngineState } from "../../api";
import { relative } from "../../format";
import type { MarketsView } from "../../markets";
import { closeSymbol, dateHeading, hourText, investPath, priceText, signedCadText, signedPct, toneOf, useSymbol, type SymbolView } from "../../simple";
import { Markdown } from "../Markdown";
import { WhatItMade } from "../WhatItMade";
import { AdviceTag } from "../markets/AdviceTag";
import { PriceChart } from "../markets/PriceChart";
import { SourceTag } from "../markets/SourceTag";
import { TvChart } from "./TvChart";
import { TvWidget } from "./TvWidget";

type Line = { ok: boolean; text: string } | null;
const research = (spaceId: string, key: string) => `/api/investing/${encodeURIComponent(spaceId)}/research/${encodeURIComponent(key)}`;

function ListMenu({ spaceId, view }: { spaceId: string; view: SymbolView }) {
  const [open, setOpen] = useState(false);
  const [line, setLine] = useState<Line>(null);
  const toggle = async (l: SymbolView["lists"][number]) => {
    const path = `${investPath(spaceId)}/lists/${encodeURIComponent(l.id)}/items`;
    const res = l.has ? await del(`${path}/${encodeURIComponent(view.key)}`) : await post(path, { key: view.key, name: view.name });
    setLine(res.ok ? { ok: true, text: l.has ? `Removed ${view.key} from ${l.name}.` : `Added ${view.key} to ${l.name}.` } : { ok: false, text: res.error });
  };
  return (
    <span className="sym-menu-wrap">
      <button className="btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ListPlus />
        Add to list
      </button>
      {open && (
        <span className="srch-menu sym-menu" role="menu">
          {view.lists.map((l) => (
            <button key={l.id} role="menuitemcheckbox" aria-checked={l.has} onClick={() => void toggle(l)}>
              <span className="sym-check">{l.has && <Check />}</span>
              {l.name}
            </button>
          ))}
        </span>
      )}
      {line && <span className={line.ok ? "ok-line" : "err"}>{line.text}</span>}
    </span>
  );
}

function AlertForm({ spaceId, view, onDone }: { spaceId: string; view: SymbolView; onDone: () => void }) {
  const [kind, setKind] = useState<"price_above" | "price_below" | "pct_move">("price_above");
  const [value, setValue] = useState(view.price ? view.price.value.toFixed(2) : "");
  const [note, setNote] = useState("");
  const [line, setLine] = useState<Line>(null);
  const create = async () => {
    const n = Number(value);
    const rule: AlertRule = kind === "pct_move" ? { kind, pct: n } : { kind, level: n };
    const res = await post(`/api/markets/${encodeURIComponent(spaceId)}/alerts`, { key: view.key, rule, note: note.trim() || undefined });
    setLine(res.ok ? { ok: true, text: `Alert set: ${view.key} ${describeRule(rule, view.key)}.` } : { ok: false, text: res.error });
  };
  return (
    <form
      className="sym-alert"
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <select value={kind} aria-label="Alert type" onChange={(e) => setKind(e.target.value as typeof kind)}>
        <option value="price_above">Price above</option>
        <option value="price_below">Price below</option>
        <option value="pct_move">Moves more than</option>
      </select>
      <label className="sym-num">
        {kind !== "pct_move" && <span>{currencyOfKey(view.key) === "USD" ? "US$" : "CA$"}</span>}
        <input inputMode="decimal" value={value} aria-label={kind === "pct_move" ? "Percent" : "Price"} onChange={(e) => setValue(e.target.value)} />
        {kind === "pct_move" && <span>% in a day</span>}
      </label>
      <input className="sym-note-in" value={note} maxLength={200} placeholder="Note (optional)" aria-label="Note" onChange={(e) => setNote(e.target.value)} />
      <button className="btn p" type="submit" disabled={!Number(value)}>
        Create alert
      </button>
      <button className="btn link" type="button" onClick={onDone}>
        Close
      </button>
      {line && <span className={line.ok ? "ok-line" : "err"}>{line.text}</span>}
    </form>
  );
}

function EarningsDate({ spaceId, view }: { spaceId: string; view: SymbolView }) {
  const [adding, setAdding] = useState(false);
  const [date, setDate] = useState("");
  const [hour, setHour] = useState("");
  const [line, setLine] = useState<Line>(null);
  if (view.earnings) {
    const e = view.earnings;
    return (
      <p className="sym-fact">
        {[dateHeading(e.date), hourText(e.hour), e.epsEstimate !== null ? `EPS est. ${e.epsEstimate.toFixed(2)}` : null].filter(Boolean).join(" · ")}
        {e.source === "you" && <span className="faint"> · your date</span>}
      </p>
    );
  }
  const save = async () => {
    const res = await post(`${research(spaceId, view.key)}/earnings`, { date, hour: hour || undefined });
    setLine(res.ok ? { ok: true, text: "Saved." } : { ok: false, text: res.error });
    if (res.ok) setAdding(false);
  };
  return (
    <div className="sym-fact">
      <span className="faint">No date yet</span>
      {view.exchange !== "US" &&
        (adding ? (
          <form
            className="sym-date"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <input type="date" value={date} aria-label="Earnings date" onChange={(e) => setDate(e.target.value)} />
            <select value={hour} aria-label="Time" onChange={(e) => setHour(e.target.value)}>
              <option value="">Time not set</option>
              <option value="bmo">Before open</option>
              <option value="amc">After close</option>
            </select>
            <button className="btn p" type="submit" disabled={!date}>
              Save
            </button>
          </form>
        ) : (
          <button className="btn link" onClick={() => setAdding(true)}>
            Add a date
          </button>
        ))}
      {line && <span className={line.ok ? "ok-line" : "err"}>{line.text}</span>}
    </div>
  );
}

function Note({ spaceId, view }: { spaceId: string; view: SymbolView }) {
  const [text, setText] = useState(view.notes);
  const [line, setLine] = useState<Line>(null);
  const save = async () => {
    if (text === view.notes) return;
    const res = await put(`${research(spaceId, view.key)}/notes`, { notes: text });
    setLine(res.ok ? { ok: true, text: "Saved." } : { ok: false, text: res.error });
  };
  return (
    <>
      <textarea className="sym-notes" value={text} rows={5} placeholder={`What you want to remember about ${view.key}.`} aria-label="Your note" onChange={(e) => setText(e.target.value)} onBlur={() => void save()} />
      {line && <span className={line.ok ? "ok-line" : "err"}>{line.text}</span>}
    </>
  );
}

function Ask({ spaceId, view, now }: { spaceId: string; view: SymbolView; now: number }) {
  const [q, setQ] = useState("");
  const [line, setLine] = useState<Line>(null);
  const input = useRef<HTMLInputElement>(null);
  const open = view.asks.find((a) => a.status === "queued" || a.status === "running");
  const ask = async () => {
    const res = await post(`${investPath(spaceId)}/symbol/${encodeURIComponent(view.key)}/ask`, { question: q });
    setLine(res.ok ? null : { ok: false, text: res.error });
    if (res.ok) setQ("");
  };
  return (
    <section className="sym-ask" id="ask">
      <h3>Ask Claude</h3>
      {open ? (
        <p className="sym-asking">
          Claude is looking at {view.key}… <a href={`/space/${spaceId}?task=${open.taskId}`}>Open the task</a>
        </p>
      ) : (
        <form
          className="sym-ask-form"
          onSubmit={(e) => {
            e.preventDefault();
            void ask();
          }}
        >
          <input ref={input} value={q} maxLength={500} placeholder="Anything specific? Leave blank for a quick overview." aria-label="Question for Claude" onChange={(e) => setQ(e.target.value)} />
          <button className="btn p" type="submit">
            <Sparkles />
            Ask Claude about this
          </button>
        </form>
      )}
      {line && <p className="err">{line.text}</p>}
      {view.asks
        .filter((a) => a.status === "done" || a.status === "failed")
        .map((a) => (
          <article key={a.id} className="sym-answer">
            <header>
              <b>{a.question || "Quick overview"}</b>
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

function KeyStats({ view }: { view: SymbolView }) {
  if (!view.stats.length) return <p className="faint sym-fact">No stats yet. Finnhub's figures arrive with the weekly refresh.</p>;
  return (
    <dl className="sym-stats">
      {view.stats.map((s) => (
        <div key={s.label} title={s.source}>
          <dt>{s.label}</dt>
          <dd>{s.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function News({ view, now }: { view: SymbolView; now: number }) {
  if (!view.news.length) return <p className="faint sym-fact">No recent news from Finnhub.</p>;
  return (
    <ul className="sym-news">
      {view.news.map((n) => (
        <li key={n.url}>
          <a href={n.url} target="_blank" rel="noopener noreferrer">
            {n.headline}
          </a>
          <span className="faint">
            {n.source} · {relative(n.at, now)}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function SymbolBody({
  spaceId,
  view,
  marketsView,
  frameUrl,
  now = Date.now(),
  refreshNote = null,
}: {
  spaceId: string;
  view: SymbolView;
  marketsView: MarketsView | null;
  frameUrl?: ((tv: string) => string) | null;
  now?: number;
  refreshNote?: string | null;
}) {
  const [alerting, setAlerting] = useState(false);
  const live = !!useEngineState()?.embed;
  const ccy = currencyOfKey(view.key);
  const p = view.position;
  return (
    <div className="sym">
      <button className="btn link sym-back" onClick={() => closeSymbol(spaceId)}>
        <ArrowLeft />
        Back
      </button>
      <header className="sym-head">
        <div className="sym-title">
          <h2>
            {view.key} <span className="chip">{view.exchange}</span>
          </h2>
          {view.name && <span className="sym-name">{view.name}</span>}
        </div>
        <div className="sym-quote">
          {view.price ? <span className="sym-price">{priceText(view.price.value, ccy)}</span> : <span className="sym-price faint">No price yet</span>}
          {view.dayPct !== null && <span className={`pill ${toneOf(view.dayPct)}`}>{signedPct(view.dayPct, 2)} today</span>}
          {view.price && <SourceTag s={view.price} />}
        </div>
        {view.estimate && (
          <p className="sym-est" title={view.estimate.source}>
            Estimate now: {priceText(view.estimate.value, ccy)} · {view.estimate.source}
          </p>
        )}
        {refreshNote && <p className="faint sym-refresh">{refreshNote}</p>}
        <div className="sym-acts">
          <ListMenu spaceId={spaceId} view={view} />
          <button className="btn" aria-expanded={alerting} onClick={() => setAlerting(!alerting)}>
            <Bell />
            Set alert
          </button>
          <a className="btn" href="#ask">
            <Sparkles />
            Ask Claude about this
          </a>
        </div>
        {alerting && <AlertForm spaceId={spaceId} view={view} onDone={() => setAlerting(false)} />}
      </header>

      <TvChart
        tv={view.tv}
        coverage={view.chart}
        frameUrl={frameUrl}
        fallback={marketsView ? <PriceChart view={marketsView} initialKey={view.key} fixed /> : <div className="inv-loading">Atrium's chart appears once prices load.</div>}
      />

      <div className="sym-cols">
        <div>
          {p && (
            <section>
              <h3>Your position</h3>
              <p className="sym-fact">
                {p.quantity} {p.quantity === 1 ? "share" : "shares"} in {p.accounts.join(" and ")}
                {p.valueCad !== null && ` · CA$${Math.round(p.valueCad).toLocaleString("en-US")}`}
                {p.gainCad !== null && p.gainCadPct !== null && (
                  <span className={`inv-gain-inline ${toneOf(p.gainCad)}`}>
                    {" "}
                    · {signedCadText(p.gainCad, 0)} ({signedPct(p.gainCadPct)})
                  </span>
                )}
              </p>
            </section>
          )}
          <section>
            <h3>Next earnings</h3>
            <EarningsDate spaceId={spaceId} view={view} />
          </section>
          {(view.kind === "stock" || view.stats.length > 0) && (
            <section>
              <h3>Key stats</h3>
              {view.kind === "stock" ? (
                <TvWidget tv={view.tv} kind="financials" className="tvw-panel tvw-tall" title={`${view.key} fundamentals by TradingView`} fallback={<KeyStats view={view} />} />
              ) : (
                <KeyStats view={view} />
              )}
            </section>
          )}
          {live && (
            <section>
              <h3>About</h3>
              <TvWidget tv={view.tv} kind="profile" className="tvw-panel" title={`${view.key} profile by TradingView`} fallback={null} />
            </section>
          )}
        </div>
        <div>
          {(view.kind === "stock" || view.news.length > 0) && (
            <section>
              <h3>News</h3>
              {view.kind === "stock" ? (
                <TvWidget tv={view.tv} kind="timeline" className="tvw-panel tvw-tall" title={`${view.key} news by TradingView`} fallback={<News view={view} now={now} />} />
              ) : (
                <News view={view} now={now} />
              )}
            </section>
          )}
          <section>
            <h3>Your note</h3>
            <Note key={view.key} spaceId={spaceId} view={view} />
          </section>
        </div>
      </div>

      <Ask spaceId={spaceId} view={view} now={now} />
    </div>
  );
}

export function SymbolPage({ spaceId, symbolKey, marketsView }: { spaceId: string; symbolKey: string; marketsView: MarketsView | null }) {
  const view = useSymbol(spaceId, symbolKey);
  const [note, setNote] = useState<string | null>(null);
  // One refresh per opening of a symbol; re-renders and engine changes don't send another.
  useEffect(() => {
    setNote(null);
    let live = true;
    void post<{ refreshed: boolean; note: string | null }>(`${investPath(spaceId)}/symbol/${encodeURIComponent(symbolKey)}/refresh`).then((r) => {
      if (live && r.ok) setNote(r.data.note);
    });
    return () => {
      live = false;
    };
  }, [spaceId, symbolKey]);
  if (!view) return <div className="inv-loading">Loading {symbolKey}…</div>;
  return <SymbolBody spaceId={spaceId} view={view} marketsView={marketsView} refreshNote={note} />;
}
