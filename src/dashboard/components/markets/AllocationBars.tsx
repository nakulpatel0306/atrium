import { useState } from "react";
import type { CompanySlice, Slice } from "../../../engine/markets/health";
import { money } from "../../format";
import { pctText } from "../../investing";

// Plain bars: one row per slice, its width the share of the portfolio. A row with a breakdown opens it on click.
export function AllocationBars({ rows, detail }: { rows: (Slice | CompanySlice)[]; detail?: (row: CompanySlice) => string | null }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!rows.length) return <div className="empty-row">Nothing to show yet.</div>;
  const max = Math.max(...rows.map((r) => r.pct), 1);
  return (
    <div className="alloc">
      {rows.map((r) => {
        const more = detail && "via" in r ? detail(r) : null;
        return (
          <div key={r.label}>
            <div
              className={`alloc-row${more ? " clickable" : ""}`}
              role={more ? "button" : undefined}
              tabIndex={more ? 0 : undefined}
              onClick={() => more && setOpen(open === r.label ? null : r.label)}
              onKeyDown={(e) => more && e.key === "Enter" && setOpen(open === r.label ? null : r.label)}
            >
              <span className="alloc-label" title={r.label}>
                {r.label}
              </span>
              <span className="alloc-track">
                <span className="alloc-bar" style={{ width: `${(r.pct / max) * 100}%` }} />
              </span>
              <span className="num">{pctText(r.pct)}</span>
              <span className="num faint">{money(r.cad, "CAD")}</span>
            </div>
            {open === r.label && more && <div className="alloc-more">{more}</div>}
          </div>
        );
      })}
    </div>
  );
}
