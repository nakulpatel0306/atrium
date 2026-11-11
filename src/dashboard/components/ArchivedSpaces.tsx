import { RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { type State, useEngineState } from "../api";
import { absolute, relative } from "../format";
import { kindLabel, setArchived } from "../spaces";
import { DeleteSpace } from "./DeleteSpace";

type Space = State["spaces"][number];

function Row({ space, onDelete }: { space: Space; onDelete(): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const restore = async () => {
    setBusy(true);
    const res = await setArchived(space, false);
    setBusy(false);
    if (!res.ok) setError(res.error ?? null);
  };
  return (
    <div className="entry">
      <div className="item archived-row">
        <span className="sd" style={{ background: space.color }} />
        <span className="t">
          <b>{space.name}</b>
          <span>{space.goal}</span>
        </span>
        {kindLabel(space.kind) && <span className="tag">{kindLabel(space.kind)}</span>}
        <span className="faint" title={absolute(space.updatedAt)}>
          Archived {relative(space.updatedAt)}
        </span>
        <button className="btn" disabled={busy} onClick={() => void restore()}>
          <RotateCcw />
          Restore
        </button>
        <button className="btn" onClick={onDelete}>
          <Trash2 />
          Delete…
        </button>
      </div>
      {error && <div className="row-err err">{error}</div>}
    </div>
  );
}

// After the page's own scroll-to-top on a route change.
export const showArchived = () => setTimeout(() => document.getElementById("archived")?.scrollIntoView({ block: "start" }), 50);

// Archived spaces stop taking work and leave the sidebar; here they can come back, or go for good.
export function ArchivedSpaces() {
  const state = useEngineState();
  const [deleting, setDeleting] = useState<Space | null>(null);
  const archived = state?.archived ?? [];

  useEffect(() => {
    if (location.hash === "#archived") showArchived();
  }, []);

  return (
    <>
      <h2 id="archived">Archived spaces</h2>
      <div className="list">
        {archived.length === 0 ? (
          <div className="empty-row">No archived spaces. Archive one from its page when the work is done.</div>
        ) : (
          archived.map((s) => <Row key={s.id} space={s} onDelete={() => setDeleting(s)} />)
        )}
      </div>
      {deleting && <DeleteSpace space={deleting} onClose={() => setDeleting(null)} />}
    </>
  );
}
