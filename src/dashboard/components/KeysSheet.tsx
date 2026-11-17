import { useEffect, useRef } from "react";
import { KIND } from "../../engine/words";

// The keys that work on this page, and on Needs you what each kind of item asks, in the words every surface uses
// (engine/words.ts).
// `floating`: over a long page it opens where the user is, not at the top they scrolled away from.
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
          </dl>
        </>
      )}
      <button className="btn" onClick={onClose}>
        Close
      </button>
    </div>
  );
}
