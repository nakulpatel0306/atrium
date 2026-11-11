import { useEffect, useRef } from "react";
import type { State } from "../api";
import { ACT, moveFocus, needsKey } from "../needs-keys";
import { NeedsList, needsCount } from "./NeedsYou";

// Everything waiting on Nakul as one list he can work through from the keyboard. The rows are the same ones Home
// and each space show; the keys only press their own buttons, so behavior can't drift between the two.
export function NeedsPage({ state }: { state: State }) {
  const list = useRef<HTMLDivElement>(null);
  // The last focused position, so after a row is answered and leaves, j picks up where it was.
  const at = useRef(-1);
  const count = needsCount(state);

  useEffect(() => {
    const rows = () => [...(list.current?.children ?? [])].filter((el): el is HTMLElement => el instanceof HTMLElement && !el.classList.contains("empty-row"));
    const focusRow = (i: number) => {
      const row = rows()[i];
      if (!row) return;
      at.current = i;
      row.tabIndex = -1;
      row.focus();
      row.scrollIntoView({ block: "nearest" });
    };
    const onKey = (e: KeyboardEvent) => {
      const key = needsKey(e);
      if (!key) return;
      const all = rows();
      const current = all.findIndex((r) => r.contains(document.activeElement));
      if (key === "next" || key === "prev") {
        e.preventDefault();
        return focusRow(moveFocus(current >= 0 ? current : at.current, all.length, key));
      }
      const row = all[current];
      // Enter on a button inside a row is that button's own press.
      if (!row || (key === "open" && document.activeElement !== row)) return;
      const open = row.querySelector<HTMLButtonElement>('[data-act="open"]');
      if (key === "close") {
        if (open?.getAttribute("aria-expanded") === "true") open.click();
        return row.focus();
      }
      const button = row.querySelector<HTMLButtonElement>(`[data-act="${ACT[key]}"]`);
      if (!button || button.disabled) return;
      // Keeps the letter out of the note field that s is about to focus.
      e.preventDefault();
      button.click();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="wrap">
      <div className="page-head">
        <h1>Needs you{count > 0 && ` · ${count}`}</h1>
        <p className="keys-hint" title="j and k move, Enter opens, a approves a review, s opens the send-back note, Esc closes">
          Keys: <kbd>j</kbd> <kbd>k</kbd> <kbd>a</kbd> <kbd>s</kbd>
        </p>
      </div>
      <p className="brief">Reviews, questions and texts waiting on you. A text only goes when you press its Send.</p>
      <NeedsList state={state} listRef={list} />
    </div>
  );
}
