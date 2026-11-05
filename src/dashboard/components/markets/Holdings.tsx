import { Plus, Upload } from "lucide-react";
import { useState } from "react";
import { del, patch, post } from "../../api";
import { absolute, money, relative, signedPct } from "../../format";
import { currencyOfKey } from "../../../engine/markets/labels";
import { dayPct, holdingTotals, type MarketsView } from "../../markets";
import { fxLabel, toCad } from "../../../engine/markets/sourced";
import { Freshness } from "./Freshness";
import { Estimate } from "./Watchlist";
import { ImportDialog } from "./ImportDialog";

type Row = MarketsView["holdings"][number];
type Cur = "CAD" | "USD";

const SOURCE: Record<Row["source"], string> = {
  manual: "Added by hand",
  wealthsimple_holdings: "Imported from a Wealthsimple holdings report",
  wealthsimple_activity: "Rebuilt from a Wealthsimple activity export",
};

const value = (h: Row) => (h.quote ? h.quantity * h.quote.price : null);
const dayMove = (h: Row) => (h.quote?.prevClose ? h.quantity * (h.quote.price - h.quote.prevClose) : null);

function Totals({ rows }: { rows: Row[] }) {
  const t = holdingTotals(rows);
  return (
    <span className="mk-totals">
      {(Object.keys(t.value) as Cur[]).map((cur) => {
        const day = t.day[cur] ?? 0;
        return (
          <span key={cur}>
            {money(t.value[cur]!, cur)} <span className={day >= 0 ? "up" : "down"}>{day >= 0 ? "+" : "−"}{money(Math.abs(day), cur)}</span>
          </span>
        );
      })}
    </span>
  );
}

function HoldingDetail({ h, spaceId }: { h: Row; spaceId: string }) {
  const [qty, setQty] = useState(String(h.quantity));
  const [book, setBook] = useState(h.bookValue === null ? "" : String(h.bookValue));
  const [error, setError] = useState<string | null>(null);
  const url = `/api/markets/${encodeURIComponent(spaceId)}/holdings/${h.id}`;
  const save = async () => {
    const res = await patch(url, { quantity: Number(qty), bookValue: book.trim() ? Number(book) : null });
    setError(res.ok ? null : res.error);
  };
  return (
    <div className="detail mk-detail">
      <div className="meta">
        <span>{SOURCE[h.source]}</span>
        <span title={absolute(h.updatedAt)}>updated {relative(h.updatedAt)}</span>
        {h.quote && <span>price at {absolute(h.quote.at)}</span>}
      </div>
      <form
        className="mk-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label>
          Quantity
          <input className="mk-input" value={qty} onChange={(e) => setQty(e.target.value)} inputMode="decimal" />
        </label>
        <label>
          Book value ({h.currency})
          <input className="mk-input" value={book} placeholder="unknown" onChange={(e) => setBook(e.target.value)} inputMode="decimal" />
        </label>
        <button className="btn" type="submit">
          Save
        </button>
        <button className="btn danger" type="button" onClick={() => void del(url)}>
          Remove
        </button>
        {error && <span className="err">{error}</span>}
      </form>
    </div>
  );
}

function AddHolding({ spaceId, onDone }: { spaceId: string; onDone: () => void }) {
  const [f, setF] = useState({ account: "TFSA", key: "", quantity: "", bookValue: "", currency: "CAD" as Cur });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = async () => {
    const res = await post(`/api/markets/${encodeURIComponent(spaceId)}/holdings`, {
      account: f.account,
      key: f.key,
      quantity: Number(f.quantity),
      bookValue: f.bookValue.trim() ? Number(f.bookValue) : null,
      currency: f.currency,
    });
    if (!res.ok) return setError(res.error);
    onDone();
  };
  return (
    <form
      className="mk-form boxed"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label>
        Account
        <input className="mk-input" value={f.account} onChange={set("account")} />
      </label>
      <label>
        Symbol
        <input className="mk-input" value={f.key} placeholder="SHOP.TO" onChange={set("key")} autoFocus />
      </label>
      <label>
        Quantity
        <input className="mk-input" value={f.quantity} onChange={set("quantity")} inputMode="decimal" />
      </label>
      <label>
        Book value
        <input className="mk-input" value={f.bookValue} placeholder="optional" onChange={set("bookValue")} inputMode="decimal" />
      </label>
      <label>
        Currency
        <select className="pick" value={f.currency} onChange={set("currency")}>
          <option>CAD</option>
          <option>USD</option>
        </select>
      </label>
      <button className="btn p" type="submit">
        Add holding
      </button>
      <button className="btn" type="button" onClick={onDone}>
        Cancel
      </button>
      {error && <span className="err">{error}</span>}
    </form>
  );
}

export function Holdings({ view }: { view: MarketsView }) {
  const cad = (h: Row) => (value(h) === null ? null : toCad(value(h)!, currencyOfKey(h.key), view.fx));
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const accounts = [...new Set(view.holdings.map((h) => h.account))];

  return (
    <section>
      <h2>
        Holdings
        {view.holdings.length > 0 && <Totals rows={view.holdings} />}
        <span className="h2-acts">
          <button className="btn" onClick={() => setAdding(!adding)}>
            <Plus />
            Add by hand
          </button>
          <button className="btn" onClick={() => setImporting(!importing)}>
            <Upload />
            Import from Wealthsimple
          </button>
        </span>
      </h2>
      {importing && <ImportDialog spaceId={view.spaceId} onClose={() => setImporting(false)} />}
      {adding && <AddHolding spaceId={view.spaceId} onDone={() => setAdding(false)} />}
      <div className="list">
        {view.holdings.length === 0 && <div className="empty-row">No holdings yet. Import a Wealthsimple holdings report or add them by hand.</div>}
        {accounts.map((account) => {
          const rows = view.holdings.filter((h) => h.account === account);
          return (
            <div key={account}>
              <div className="mk-group">
                <b>{account}</b>
                <Totals rows={rows} />
              </div>
              <div className="mk-row mk-cols">
                <span className="sym">Symbol</span>
                <span className="t" />
                <span className="num">Qty</span>
                <span className="num">Book value</span>
                <span className="num">Market value</span>
                <span className="num day">Today</span>
                <span className="num" title={view.fx ? fxLabel(view.fx) : "No Bank of Canada rate yet"}>
                  CAD
                </span>
                <span className="fresh-col">Price source</span>
              </div>
              {rows.map((h) => {
                const day = dayMove(h);
                const pct = h.quote ? dayPct(h.quote) : null;
                return (
                  <div key={h.id} className="entry">
                    <div className="item mk-row" role="button" tabIndex={0} onClick={() => setOpen(open === h.id ? null : h.id)} onKeyDown={(e) => e.key === "Enter" && setOpen(open === h.id ? null : h.id)}>
                      <span className="sym">{h.key}</span>
                      <span className="t">{h.name}</span>
                      <span className="num">{h.quantity}</span>
                      <span className="num">{h.bookValue === null ? "—" : money(h.bookValue, h.currency)}</span>
                      <span className="num">{value(h) === null ? "—" : money(value(h)!, currencyOfKey(h.key))}</span>
                      <span className={`num day ${day === null ? "faint" : day >= 0 ? "up" : "down"}`}>
                        {day === null ? "—" : `${day >= 0 ? "+" : "−"}${money(Math.abs(day), currencyOfKey(h.key))}`}
                        {pct !== null && <small> {signedPct(pct)}</small>}
                      </span>
                      <span className="num" title={view.fx && value(h) !== null ? `${fxLabel(view.fx)}` : undefined}>
                        {cad(h) === null ? "—" : money(cad(h)!, "CAD")}
                      </span>
                      <Freshness quote={h.quote} missing={h.missing} />
                    </div>
                    <Estimate e={view.estimates[h.key]} />
                    {open === h.id && <HoldingDetail h={h} spaceId={view.spaceId} />}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </section>
  );
}
