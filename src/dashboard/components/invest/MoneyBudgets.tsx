import { useState } from "react";
import type { MoneyView } from "../../../engine/money/summary";
import { put } from "../../api";
import { cadText, investPath } from "../../simple";

type Row = { category: string; spent: number; count: number; limit: number | null };

// Spending by category, each with an optional monthly limit set right on its row. A heads-up goes out once at 80%
// and once at 100%.
export function MoneyBudgets({ spaceId, view }: { spaceId: string; view: MoneyView }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const limits = new Map(view.budgets.map((b) => [b.category, b.limit]));
  const rows: Row[] = view.spending.map((s) => ({ category: s.category, spent: s.amount, count: s.count, limit: limits.get(s.category) ?? null }));
  for (const b of view.budgets) if (!rows.some((r) => r.category === b.category)) rows.push({ category: b.category, spent: 0, count: 0, limit: b.limit });
  const max = Math.max(1, ...rows.map((r) => Math.max(r.spent, r.limit ?? 0)));
  const save = async (category: string, limit: number | null) => {
    const res = await put(`${investPath(spaceId)}/money/budgets`, { category, limit });
    if (res.ok) {
      setEditing(null);
      setError(null);
    } else setError(res.error);
  };
  if (!rows.length) return <p className="faint">No spending this month.</p>;
  return (
    <>
      <ul className="money-cats money-budgets">
        {rows.map((r) => {
          const pct = r.limit ? (r.spent / r.limit) * 100 : null;
          // Without a limit the bar only compares categories, so it stays quiet.
          const tone = pct === null ? " plain" : pct >= 100 ? " over" : pct >= 80 ? " near" : "";
          return (
            <li key={r.category}>
              <span className="money-cat">{r.category}</span>
              <span className={`money-bar${tone}`} aria-hidden>
                <span style={{ width: `${Math.min(100, ((r.limit ? r.spent / r.limit : r.spent / max) * 100))}%` }} />
              </span>
              <span className="money-amt">{cadText(r.spent)}</span>
              {editing === r.category ? (
                <form
                  className="money-limit-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const n = Number(value.replace(/[$,\s]/g, ""));
                    void save(r.category, value.trim() === "" || n === 0 ? null : n);
                  }}
                >
                  <input value={value} inputMode="decimal" aria-label={`Monthly limit for ${r.category}`} placeholder="400" autoFocus onChange={(e) => setValue(e.target.value)} />
                  <button className="btn p" type="submit">
                    Save
                  </button>
                </form>
              ) : (
                <button
                  className={`btn link money-limit${r.limit ? "" : " unset"}`}
                  onClick={() => {
                    setEditing(r.category);
                    setValue(r.limit ? String(r.limit) : "");
                  }}
                >
                  {r.limit ? `of ${cadText(r.limit, 0)}` : "Set limit"}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {editing && <p className="hint">Leave it empty to remove the limit.</p>}
      {error && <p className="err">{error}</p>}
    </>
  );
}
