import { useState } from "react";
import { accountLabel, OTHER_ACCOUNT } from "../../../engine/money/banks";
import type { ImportRow } from "../../../engine/money/imports";
import type { MoneyView } from "../../../engine/money/summary";
import { del, post } from "../../api";
import { relative } from "../../format";
import { shortDate } from "./MoneyRecap";

const SHOWN = 5;
const rowsText = (n: number) => `${n} ${n === 1 ? "row" : "rows"}`;

// One import: what it covered, and the two ways to fix a wrong one. Both ask first, inline, where the click was.
function Import({ imp, view, now }: { imp: ImportRow; view: MoneyView; now: number }) {
  const [step, setStep] = useState<"idle" | "undo" | "move">("idle");
  const [account, setAccount] = useState(view.importAccounts[0] ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unknown = imp.account === OTHER_ACCOUNT;
  const run = async (send: () => ReturnType<typeof post>) => {
    setBusy(true);
    const res = await send();
    setBusy(false);
    setError(res.ok ? null : res.error);
    if (res.ok) setStep("idle");
  };
  return (
    <li>
      {unknown && !view.busy ? (
        <b className="money-unknown">
          Unknown account.{" "}
          <button className="btn link" onClick={() => setStep("move")}>
            Change it?
          </button>
        </b>
      ) : (
        <b>{accountLabel(imp.account)}</b>
      )}
      <span>{rowsText(imp.rows)}</span>
      <span className="faint">
        {shortDate(imp.from)} to {shortDate(imp.to)} · imported {relative(imp.importedAt, now)}
      </span>
      {!view.busy && step === "idle" && (
        <span className="money-import-acts">
          <button className="btn link" onClick={() => setStep("move")}>
            Change account
          </button>
          <button className="btn link" onClick={() => setStep("undo")}>
            Undo import
          </button>
        </span>
      )}
      {!view.busy && step === "undo" && (
        <span className="money-import-acts">
          <span>Remove the {rowsText(imp.rows)} this import added?</span>
          <button className="btn danger" disabled={busy} onClick={() => void run(() => del(`/api/money/imports/${imp.id}`))}>
            Remove
          </button>
          <button className="btn" disabled={busy} onClick={() => setStep("idle")}>
            Keep
          </button>
        </span>
      )}
      {!view.busy && step === "move" && (
        <span className="money-import-acts">
          <select value={account} aria-label="Move to account" onChange={(e) => setAccount(e.target.value)}>
            {view.importAccounts.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <button className="btn p" disabled={busy || !account} onClick={() => void run(() => post(`/api/money/imports/${imp.id}/account`, { account }))}>
            Move
          </button>
          <button className="btn" disabled={busy} onClick={() => setStep("idle")}>
            Cancel
          </button>
          <span className="faint">Rows that account already has are left out.</span>
        </span>
      )}
      {error && <span className="err">{error}</span>}
    </li>
  );
}

// Every import, newest first, so a wrong file can be taken back out or put in the right account.
export function MoneyImports({ view, now }: { view: MoneyView; now: number }) {
  const [all, setAll] = useState(false);
  if (!view.imports.length) return null;
  const shown = all ? view.imports : view.imports.slice(0, SHOWN);
  return (
    <>
      {view.busy && <p className="faint">Claude is looking at your money. Undo and Change account come back when it's done.</p>}
      <ul className="money-list money-imports">
        {shown.map((imp) => (
          <Import key={imp.id} imp={imp} view={view} now={now} />
        ))}
      </ul>
      {view.imports.length > SHOWN && (
        <button className="btn link" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${view.imports.length} imports`}
        </button>
      )}
    </>
  );
}
