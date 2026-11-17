import { KIND } from "../../engine/words";

// The keys that work on this page, and on Needs you what each kind of item asks, in the words every surface uses
// (engine/words.ts).
export function KeysSheet({ keys, kinds = false, note, onClose }: { keys: [string, string][]; kinds?: boolean; note?: string; onClose: () => void }) {
  return (
    <div className="keys-sheet" role="dialog" aria-label="Keys">
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
