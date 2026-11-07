import { useState } from "react";
import type { MoneyView } from "../../../engine/money/summary";
import { post } from "../../api";
import { investPath } from "../../simple";
import { shortDate } from "./MoneyRecap";

const amountText = (n: number) => `${n < 0 ? "−" : "+"}${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const WHY = { marked: "You marked it as a transfer.", known: "A payment or top-up between your accounts.", pair: "The same amount moved between two of your accounts." } as const;

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
                <td className="faint">{t.account}</td>
                <td className="faint">{t.transfer ? <span className="money-flag transfer" title={WHY[t.transfer]}>transfer</span> : t.category}</td>
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
