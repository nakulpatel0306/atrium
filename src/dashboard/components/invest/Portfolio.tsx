import { Upload } from "lucide-react";
import { useState } from "react";
import { fxLabel } from "../../../engine/markets/sourced";
import { cadText, openSymbol, signedCadText, signedPct, toneOf, type PortfolioView } from "../../simple";
import { Markdown } from "../Markdown";
import { AdviceTag } from "../markets/AdviceTag";
import { ImportDialog } from "../markets/ImportDialog";
import { SourceTag } from "../markets/SourceTag";
import { PriceRow } from "./PriceRow";

export function Portfolio({ spaceId, view }: { spaceId: string; view: PortfolioView }) {
  const [importing, setImporting] = useState(false);
  const dialog = importing && <ImportDialog spaceId={spaceId} onClose={() => setImporting(false)} />;
  if (view.empty) {
    return (
      <section className="inv-empty">
        <p>No holdings yet. Import your Wealthsimple holdings file to see your portfolio.</p>
        <button className="btn p" onClick={() => setImporting(true)}>
          <Upload />
          Import holdings
        </button>
        <p className="faint">Your watchlists still work without it.</p>
        {dialog}
      </section>
    );
  }
  return (
    <section className="inv-portfolio">
      <header className="inv-hero">
        <span className="inv-label">Portfolio value</span>
        <span className="inv-total">{view.total ? cadText(view.total.value) : "—"}</span>
        {view.dayCad !== null && view.dayPct !== null && (
          <span className={`inv-day ${toneOf(view.dayPct)}`}>
            {signedCadText(view.dayCad)} ({signedPct(view.dayPct, 2)}) {view.dayLabel}
          </span>
        )}
        <span className="inv-source" title={view.fx ? fxLabel(view.fx) : undefined}>
          <SourceTag s={view.total ? { ...view.total, source: view.mix ?? view.total.source } : null} missing="No prices yet" />
        </span>
        {view.left && <span className="inv-left">{view.left}</span>}
      </header>
      {view.note && (
        <article className="inv-note">
          <h3>What moved</h3>
          <Markdown text={view.note.body} />
          <AdviceTag />
        </article>
      )}
      <div className="inv-list">
        <div className="inv-list-head" aria-hidden>
          <span>Holding</span>
          <span>1 month</span>
          <span>Price · today</span>
          <span>Gain</span>
        </div>
        {view.holdings.map((h) => (
          <PriceRow
            key={h.key}
            row={h}
            onOpen={() => openSymbol(spaceId, h.key)}
            extra={
              <span className={`inv-gain ${toneOf(h.gainCadPct)}`}>
                {h.gainCad !== null && h.gainCadPct !== null ? (
                  <>
                    <b>{signedCadText(h.gainCad, 0)}</b>
                    <span>{signedPct(h.gainCadPct)}</span>
                  </>
                ) : (
                  "—"
                )}
              </span>
            }
          />
        ))}
      </div>
      <p className="inv-foot">
        <button className="btn link" onClick={() => setImporting(true)}>
          Import an updated holdings file
        </button>
      </p>
      {dialog}
    </section>
  );
}
