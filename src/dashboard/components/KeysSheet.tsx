import { useEffect, useRef } from "react";
import { CLEAN, KIND, RISKY } from "../../engine/words";

// The keys that work on this page, and on Needs you what each kind of item asks, in the words every surface uses
// (engine/words.ts).
// `floating`: it opens where the user is, bottom right above the ask bar, clear of the decision buttons at the top.
export function KeysSheet({ keys, kinds = false, note, floating = false, onClose }: { keys: [string, string][]; kinds?: boolean; note?: string; floating?: boolean; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  // Focus goes to the sheet, so a screen reader says it opened; Esc closes it as before.
  useEffect(() => {
    box.current?.focus();
  }, []);
  return (
    <div className={`keys-sheet${floating ? " floating" : ""}`} role="dialog" aria-label="Keys" tabIndex={-1} ref={box}>
      <h2>Keys</h2>
      {note && <p className="hint">{note}</p>}
      <dl>
        {keys.map(([k, what]) => (
          <div key={k}>
            <dt>
              <kbd>{k}</kbd>
            </dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
      {kinds && (
        <>
          <h2>What each item asks</h2>
          <dl className="kinds">
            {Object.values(KIND).map((k) => (
              <div key={k.label}>
                <dt>{k.label}</dt>
                <dd>
                  {k.means} <span className="hint">Next: {k.action}.</span>
                </dd>
              </div>
            ))}
            {/* A Review is listed by its verdict, so both words are explained here too. */}
            <div>
              <dt>{CLEAN}</dt>
              <dd>A Review whose checks passed and whose reviewer approved, with nothing left open. One a approves it.</dd>
            </div>
            <div>
              <dt>{RISKY}</dt>
              <dd>A Review with a note, a check that didn't pass or a finding left open. Read why first; a takes two presses.</dd>
            </div>
          </dl>
        </>
      )}
      <button className="btn" onClick={onClose}>
        Close
      </button>
    </div>
  );
}
