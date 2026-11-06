import { AlertTriangle, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { CompanySlice } from "../../../engine/markets/health";
import { currencyOfKey } from "../../../engine/markets/labels";
import { post } from "../../api";
import { money } from "../../format";
import { dayText, investingPath, perfRow, pctText, signedPctText, useHealth, type HealthView } from "../../investing";
import { AllocationBars } from "./AllocationBars";
import { SourceTag } from "./SourceTag";
import { TfsaCard } from "./TfsaCard";

type View = "holding" | "sector" | "country" | "currency" | "company";
const VIEWS: { id: View; label: string }[] = [
  { id: "holding", label: "Holding" },
  { id: "sector", label: "Sector" },
  { id: "country", label: "Country" },
  { id: "currency", label: "Currency" },
  { id: "company", label: "Company" },
];

const through = (c: CompanySlice) => {
  const parts = [c.direct > 0 ? `direct ${pctText(c.direct)}` : null, ...c.via.map((v) => `through ${v.holding} ${pctText(v.pct)}`)].filter(Boolean);
  return parts.length > 1 || c.via.length ? parts.join(", ") : null;
};
const signedCad = (n: number) => `${n >= 0 ? "+" : "−"}${money(Math.abs(n), "CAD")}`;

function Allocation({ h }: { h: HealthView["health"] }) {
  const [view, setView] = useState<View>("holding");
  const [byListing, setByListing] = useState(false);
  const rows =
    view === "holding" ? h.byHolding : view === "sector" ? h.bySector : view === "country" ? h.byCountry : view === "currency" ? (byListing ? h.byListingCurrency : h.byCurrency) : h.byCompany;
  return (
    <section>
      <h2>
        Allocation
        <span className="h2-acts">
          <span className="seg" role="tablist">
            {VIEWS.map((v) => (
              <button key={v.id} aria-pressed={view === v.id} onClick={() => setView(v.id)}>
                {v.label}
              </button>
            ))}
          </span>
        </span>
      </h2>
      <div className="list">
        {view === "currency" && (
          <div className="mk-group">
            <span className="seg">
              <button aria-pressed={!byListing} onClick={() => setByListing(false)}>
                What you're exposed to
              </button>
              <button aria-pressed={byListing} onClick={() => setByListing(true)}>
                What it's listed in
              </button>
            </span>
          </div>
        )}
        <AllocationBars rows={rows} detail={view === "company" ? through : undefined} />
        {view === "company" && (
          <div className="empty-row">After looking through your ETFs: {pctText(h.lookThroughCoverage * 100)} of your fund money is matched to companies. Click a row to see where it comes from.</div>
        )}
      </div>
    </section>
  );
}

function Funds({ spaceId, funds }: { spaceId: string; funds: HealthView["funds"] }) {
  const [msg, setMsg] = useState<Record<string, string>>({});
  if (!funds.length) return null;
  const today = (asOf: string | null, f: HealthView["funds"][number]) => !!asOf && !f.lastError;
  return (
    <section>
      <h2>Fund holdings files</h2>
      <div className="list">
        {funds.map((f) => (
          <div key={f.key} className="item fund-row">
            <span className="sym">{f.key}</span>
            <span className="t">
              {f.asOf ? <b>{f.source}</b> : <b>Breakdown unavailable: {f.lastError ?? "no holdings file yet"}</b>}
              {f.note && <span>{f.note}</span>}
              {f.asOf && f.lastError && <span className="err">Last refresh failed: {f.lastError} Using the file from {f.asOf}.</span>}
              {msg[f.key] && <span className={msg[f.key]!.startsWith("Refreshed") ? "ok-line" : "err"}>{msg[f.key]}</span>}
            </span>
            <button
              className="btn"
              title={today(f.asOf, f) ? "Issuer files are fetched at most once a day per fund" : "Fetch the issuer's latest holdings file"}
              onClick={() =>
                void post<{ asOf: string }>(`${investingPath(spaceId)}/funds/${encodeURIComponent(f.key)}/refresh`).then((r) =>
                  setMsg({ ...msg, [f.key]: r.ok ? `Refreshed: holdings as of ${r.data.asOf}.` : r.error }),
                )
              }
            >
              <RefreshCw />
              Refresh
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

export function Health({ spaceId }: { spaceId: string }) {
  const v = useHealth(spaceId);
  if (!v) return <div className="empty-row">Loading portfolio health…</div>;
  const h = v.health;
  if (!h.pnl.length) {
    return (
      <div className="list">
        <div className="empty-row">Import your Wealthsimple holdings to see portfolio health.</div>
      </div>
    );
  }
  return (
    <div className="health">
      <section className="health-top">
        <div className="health-total">
          <span className="faint">Portfolio in CAD</span>
          <span className="big">{h.totalCad ? money(h.totalCad.value, "CAD") : "—"}</span>
          {h.dayCad && h.dayPct !== null && (
            <span className={h.dayCad.value >= 0 ? "up" : "down"}>
              {signedCad(h.dayCad.value)} ({signedPctText(h.dayPct)}) {dayText(h.dayOf, Date.now())}
            </span>
          )}
        </div>
        <SourceTag s={h.totalCad} missing="No prices yet" />
      </section>

      {h.warnings.length > 0 && (
        <section>
          <h2>Worth a look</h2>
          <div className="list">
            {h.warnings.map((w) => (
              <div key={w.text} className={`item warn-row ${w.kind}`}>
                <AlertTriangle />
                <span className="t">{w.text}</span>
                {w.link && (
                  <a className="btn" href={w.link}>
                    Settings → Market data
                  </a>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      <Allocation h={h} />

      {h.overlap.length > 0 && (
        <section>
          <h2>Fund overlap</h2>
          <div className="list">
            {h.overlap.map((o) => (
              <div key={`${o.a}-${o.b}`} className="item mk-row">
                <span className="t">
                  {o.a} and {o.b}
                </span>
                <span className="num">{pctText(o.pct)}</span>
              </div>
            ))}
            <div className="empty-row">Share of the smaller fund's companies that the other fund also holds, by weight.</div>
          </div>
        </section>
      )}

      <section>
        <h2>Performance in CAD</h2>
        <div className="list">
          <div className="mk-row mk-cols">
            <span className="t">Period</span>
            <span className="num">You</span>
            <span className="num">SPY</span>
            <span className="num">XEQT</span>
          </div>
          {v.performance.map((p) => {
            const r = perfRow(p);
            return (
              <div key={r.label} className="item mk-row" title={r.title}>
                <span className="t">{r.label}</span>
                <span className="num">{r.you}</span>
                <span className="num">{r.spy}</span>
                <span className="num">{r.xeqt}</span>
              </div>
            );
          })}
          <div className="empty-row">{v.performance[0]?.note} Hover a row for its dates and any n/a reasons.</div>
        </div>
      </section>

      <section>
        <h2>Gain by holding</h2>
        <div className="list">
          <div className="mk-row mk-cols">
            <span className="sym">Holding</span>
            <span className="t">Account</span>
            <span className="num">Value</span>
            <span className="num">Gain</span>
            <span className="num">Value CAD</span>
            <span className="num">Gain CAD</span>
          </div>
          {h.pnl.map((p) => (
            <div key={`${p.account}-${p.key}`} className="item mk-row" title={p.bookNote ?? undefined}>
              <span className="sym">{p.key}</span>
              <span className="t">{p.account}</span>
              <span className="num">{p.value ? money(p.value.value, currencyOfKey(p.key)) : "—"}</span>
              <span className={`num ${p.gain === null ? "faint" : p.gain >= 0 ? "up" : "down"}`}>{p.gainPct === null ? "—" : signedPctText(p.gainPct)}</span>
              <span className="num">{p.valueCad === null ? "—" : money(p.valueCad, "CAD")}</span>
              <span className={`num ${p.gainCad === null ? "faint" : p.gainCad >= 0 ? "up" : "down"}`}>
                {p.gainCad === null ? "—" : `${signedCad(p.gainCad)}`}
                {p.bookNote && " *"}
              </span>
            </div>
          ))}
          {h.pnl.some((p) => p.bookNote) && <div className="empty-row">* Hover the row: the CAD gain uses a converted or missing book value.</div>}
        </div>
      </section>

      <section>
        <h2>Dividend income, last 12 months</h2>
        <div className="list">
          <div className="item mk-row">
            <span className="t">
              <b>{v.income.totalNetCad ? `${money(v.income.totalNetCad.value, "CAD")} after withholding` : "No dividends recorded yet"}</b>
            </span>
            <SourceTag s={v.income.totalNetCad} missing="Needs a Tiingo key" />
          </div>
          {v.income.rows.map((r) => (
            <div key={r.key} className="item mk-row" title={r.note ?? undefined}>
              <span className="sym">{r.key}</span>
              <span className="t">{r.note ?? r.source}</span>
              <span className="num">{money(r.gross, r.ccy)}</span>
              <span className="num">{money(r.net, r.ccy)} net</span>
            </div>
          ))}
          {Object.entries(v.withholding)
            .filter(([k]) => !v.income.rows.some((r) => r.key === k))
            .map(([k, note]) => (
              <div key={k} className="item mk-row">
                <span className="sym">{k}</span>
                <span className="t">{note}</span>
              </div>
            ))}
          {v.income.unavailable.length > 0 && <div className="empty-row">{v.income.unavailable.map((u) => u.reason).join(" ")}</div>}
        </div>
      </section>

      <Funds spaceId={spaceId} funds={v.funds} />
      <TfsaCard />
    </div>
  );
}
