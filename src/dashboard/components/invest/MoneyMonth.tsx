import { useState } from "react";
import type { MoneyView } from "../../../engine/money/summary";
import { accountLabel } from "../../../engine/money/banks";
import { post } from "../../api";
import { investPath } from "../../simple";
import { shortDate } from "./MoneyRecap";

const amountText = (n: number) => `${n < 0 ? "−" : "+"}${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const WHY = {
  marked: "You marked it as a transfer.",
  "card-payment": "A payment to this card from one of your accounts.",
  "card-paid": "Pays one of your cards. The charges count on the card instead.",
  own: "An e-transfer between your own accounts.",
  known: "A payment or top-up between your accounts.",
  pair: "The same amount moved between two of your accounts.",
} as const;
const CARD_PAYMENT = new Set(["card-payment", "card-paid"]);
type Row = MoneyView["transactions"][number];
const flagText = (t: Row) => (t.transfer === "own" ? (t.amount < 0 ? "To your own account" : "From your own account") : CARD_PAYMENT.has(t.transfer!) ? "card payment" : "transfer");

// Why a row counts the way it does: moved between his accounts, a refund, or a bill for a card that isn't imported.
function Category({ t }: { t: Row }) {
  if (t.transfer) return <span className="money-flag flag-transfer" title={WHY[t.transfer]}>{flagText(t)}</span>;
  if (t.flow === "card-bill") return <span title="That card isn't imported, so this payment counts as spending.">{t.category}</span>;
  if (t.amount > 0 && (t.flow === "refund" || t.flow === "card-payment")) return <span title="A credit on your card. It takes spending down.">Refund · {t.category}</span>;
  return <>{t.category}</>;
}

// The month's transactions, folded away until asked for. Transfers between Nakul's own accounts are marked, and he
// can say otherwise.
export function MoneyMonth({ spaceId, view }: { spaceId: string; view: MoneyView }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!view.transactions.length) return null;
  const mark = async (id: string, transfer: boolean) => {
    const res = await post(`${investPath(spaceId)}/money/transfer`, { id, transfer });
    setError(res.ok ? null : res.error);
  };
  return (
    <section className="money-month">
      <button className="btn link" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "Hide transactions" : `Show ${view.transactions.length} transactions`}
      </button>
      {open && (
        <table className="money-sample money-tx">
          <tbody>
            {view.transactions.map((t) => (
              <tr key={t.id} className={t.transfer ? "moved" : ""}>
                <td className="faint">{shortDate(t.date)}</td>
                <td title={t.description}>{t.description}</td>
                <td className="faint">{accountLabel(t.account)}</td>
                <td className="faint"><Category t={t} /></td>
                <td className={t.amount < 0 ? "neg" : "pos"}>{amountText(t.amount)}</td>
                <td>
                  <button className="btn link" onClick={() => void mark(t.id, !t.transfer)}>
                    {t.transfer ? "Not a transfer" : "Mark as transfer"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {error && <p className="err">{error}</p>}
    </section>
  );
}
