import { ArrowDown, ArrowUp } from "lucide-react";
import { useState } from "react";
import { applyFilters, type ScreenFilter, type ScreenRow } from "../../../engine/markets/screen";
import { currencyOfKey } from "../../../engine/markets/labels";
import { money } from "../../format";
import { pctText, sortRows, useScreener } from "../../investing";
import { SourceTag } from "./SourceTag";

type Col = { by: keyof ScreenRow; label: string; filter?: ScreenFilter["field"] };
const COLS: Col[] = [
  { by: "key", label: "Symbol" },
  { by: "price", label: "Price" },
  { by: "pe", label: "P/E", filter: "pe" },
  { by: "pos52", label: "52-wk position", filter: "pos52" },
  { by: "fromHighPct", label: "From high", filter: "fromHighPct" },
  { by: "rsi14", label: "RSI 14", filter: "rsi14" },
  { by: "divYield", label: "Yield", filter: "divYield" },
];

export function Screener({ spaceId, onOpen }: { spaceId: string; onOpen: (key: string) => void }) {
  const rows = useScreener(spaceId);
  const [sort, setSort] = useState<{ by: keyof ScreenRow; dir: "asc" | "desc" }>({ by: "key", dir: "asc" });
  const [limits, setLimits] = useState<Record<string, { min: string; max: string }>>({});
  const filters: ScreenFilter[] = Object.entries(limits)
    .map(([field, l]) => ({ field: field as ScreenFilter["field"], min: l.min.trim() ? Number(l.min) : undefined, max: l.max.trim() ? Number(l.max) : undefined }))
    .filter((f) => f.min !== undefined || f.max !== undefined);
  const shown = rows ? sortRows(applyFilters(rows, filters), sort.by, sort.dir) : [];
  const setLimit = (f: string, k: "min" | "max", v: string) => setLimits({ ...limits, [f]: { min: "", max: "", ...limits[f], [k]: v } });
  return (
    <section>
      <h2>Screener</h2>
      <div className="list screener">
        <div className="mk-row mk-cols sc-row">
          {COLS.map((c) => (
            <button key={c.by} className="sc-head" onClick={() => setSort({ by: c.by, dir: sort.by === c.by && sort.dir === "asc" ? "desc" : "asc" })}>
              {c.label}
              {sort.by === c.by && (sort.dir === "asc" ? <ArrowUp /> : <ArrowDown />)}
            </button>
          ))}
        </div>
        <div className="mk-row mk-cols sc-row sc-filters">
          {COLS.map((c) =>
            c.filter ? (
              <span key={c.by} className="sc-filter">
                <input className="mk-input" placeholder="min" value={limits[c.filter]?.min ?? ""} onChange={(e) => setLimit(c.filter!, "min", e.target.value)} inputMode="decimal" />
                <input className="mk-input" placeholder="max" value={limits[c.filter]?.max ?? ""} onChange={(e) => setLimit(c.filter!, "max", e.target.value)} inputMode="decimal" />
              </span>
            ) : (
              <span key={c.by} />
            ),
          )}
        </div>
        {!rows && <div className="empty-row">Loading…</div>}
        {rows && shown.length === 0 && <div className="empty-row">Nothing matches these filters. A row without a number for a filtered column is left out.</div>}
        {shown.map((r) => (
          <div key={r.key} className="item mk-row sc-row" role="button" tabIndex={0} onClick={() => onOpen(r.key)} onKeyDown={(e) => e.key === "Enter" && onOpen(r.key)}>
            <span className="sym" title={r.name}>
              {r.key}
              {r.held && <small> held</small>}
            </span>
            <span className="num" title={r.price?.source}>
              {r.price ? money(r.price.value, currencyOfKey(r.key)) : "—"}
            </span>
            <span className="num" title={r.pe?.source}>
              {r.pe ? r.pe.value.toFixed(1) : "—"}
            </span>
            <span className="num" title={r.range52Source ?? undefined}>
              {r.pos52 === null ? "—" : pctText(r.pos52 * 100)}
            </span>
            <span className="num">{r.fromHighPct === null ? "—" : pctText(r.fromHighPct)}</span>
            <span className="num" title="RSI from Atrium's stored closes">
              {r.rsi14 === null ? "—" : r.rsi14.toFixed(0)}
            </span>
            <span className="num" title={r.divYield?.source}>
              {r.divYield ? `${r.divYield.value.toFixed(2)}%` : "—"}
            </span>
          </div>
        ))}
        {rows && rows.length > 0 && (
          <div className="empty-row">
            Hover a cell for its source. Price sources:{" "}
            {[...new Set(rows.map((r) => r.price?.source).filter(Boolean))].map((s) => (
              <SourceTag key={s} s={rows.find((r) => r.price?.source === s)!.price} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
