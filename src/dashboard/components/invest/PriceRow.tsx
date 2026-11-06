import type { ReactNode } from "react";
import { currencyOfKey } from "../../../engine/markets/labels";
import type { PriceRow as Row } from "../../../engine/markets/views";
import { priceText, signedPct, toneOf } from "../../simple";
import { Sparkline } from "./Sparkline";

// One instrument row, shared by Portfolio and Watchlists: symbol and name, the 30-day line, price and today.
export function PriceRow({ row, onOpen, extra, actions }: { row: Row; onOpen: () => void; extra?: ReactNode; actions?: ReactNode }) {
  const first = row.spark[0];
  const last = row.spark.at(-1);
  const trend = first !== undefined && last !== undefined ? last >= first : null;
  return (
    <div className="inv-row">
      <button className="inv-row-main" onClick={onOpen}>
        <span className="inv-sym">
          <b>{row.key}</b>
          <span title={row.name}>{row.name || " "}</span>
        </span>
        <Sparkline values={row.spark} up={trend} />
        <span className="inv-price">
          {row.price ? (
            <>
              <b title={row.price.source}>{priceText(row.price.value, currencyOfKey(row.key))}</b>
              {row.dayPct !== null ? <span className={`pill ${toneOf(row.dayPct)}`}>{signedPct(row.dayPct)}</span> : <span className="pill flat">—</span>}
            </>
          ) : (
            <span className="inv-missing" title={row.missing ?? undefined}>
              No price yet
            </span>
          )}
        </span>
        {extra}
      </button>
      {actions}
    </div>
  );
}
