import { Plus, X } from "lucide-react";
import { useState } from "react";
import { del, post } from "../../api";
import { money, signedPct } from "../../format";
import { dayPct, type MarketsView } from "../../markets";
import { currencyOfKey } from "../../../engine/markets/labels";
import { Freshness } from "./Freshness";

export function Change({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="num faint">—</span>;
  return <span className={`num ${pct >= 0 ? "up" : "down"}`}>{signedPct(pct)}</span>;
}

export function Watchlist({ view, onOpen }: { view: MarketsView; onOpen: (key: string) => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const base = `/api/markets/${encodeURIComponent(view.spaceId)}/watchlist`;

  const add = async () => {
    if (!text.trim()) return;
    setBusy(true);
    const res = await post(base, { key: text.trim() });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setError(null);
    setText("");
  };

  return (
    <section>
      <h2>Watchlist</h2>
      <div className="list">
        {view.watchlist.length === 0 && <div className="empty-row">Nothing on the watchlist yet. Add a symbol like AAPL or SHOP.TO below.</div>}
        {view.watchlist.map((w) => (
          <div key={w.key} className="item mk-row" role="button" tabIndex={0} onClick={() => onOpen(w.key)} onKeyDown={(e) => e.key === "Enter" && onOpen(w.key)}>
            <span className="sym">{w.key}</span>
            <span className="t">{w.name}</span>
            <span className="num">{w.quote ? money(w.quote.price, currencyOfKey(w.key)) : "—"}</span>
            <Change pct={w.quote ? dayPct(w.quote) : null} />
            <Freshness quote={w.quote} missing={w.missing} />
            <button
              className="icon-btn"
              title={`Remove ${w.key}`}
              aria-label={`Remove ${w.key}`}
              onClick={(e) => {
                e.stopPropagation();
                void del(`${base}/${encodeURIComponent(w.key)}`);
              }}
            >
              <X />
            </button>
          </div>
        ))}
        <form
          className="mk-add"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <input className="mk-input" placeholder="Add a symbol: AAPL, SHOP.TO, XYZ.V" value={text} aria-label="Symbol to watch" onChange={(e) => setText(e.target.value)} />
          <button className="btn" type="submit" disabled={busy || !text.trim()}>
            <Plus />
            Watch
          </button>
          {error && <span className="err">{error}</span>}
        </form>
      </div>
    </section>
  );
}
