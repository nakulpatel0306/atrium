import { Archive, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { type OldData, oldDataLines, oldDataStays, removedLine } from "../../engine/old-data-view";
import { post, type PostResult, useFetched } from "../api";
import { showToast } from "../toast";

// What goes, line by line, and what the removal never touches.
export function OldDataList({ data }: { data: OldData }) {
  return (
    <>
      <p className="dialog-lead">This removes:</p>
      <ul className="goes">
        {oldDataLines(data).map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      <ul className="stays">
        {oldDataStays(data).map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </>
  );
}

export async function removeOldDataNow(send: (path: string) => Promise<PostResult<OldData | null>> = post): Promise<{ toast: string } | { error: string }> {
  const res = await send("/api/old-data/remove");
  return res.ok ? { toast: removedLine(res.data) } : { error: res.error };
}

// The list comes from the engine, which also checks the Keychain, so the user confirms what is really there.
function RemoveOldData({ onClose }: { onClose: () => void }) {
  const data = useFetched<OldData | null>("/api/old-data", 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const remove = async () => {
    setBusy(true);
    setError(null);
    const r = await removeOldDataNow();
    setBusy(false);
    if ("error" in r) return setError(r.error);
    showToast(r.toast);
    onClose();
  };

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="old-data-title" onClick={(e) => e.stopPropagation()}>
        <h3 id="old-data-title">
          <Trash2 />
          Remove old data for good?
        </h3>
        {data === null ? <p className="hint">Checking what's there…</p> : <OldDataList data={data} />}
        {error && <p className="err">{error}</p>}
        <div className="dialog-acts">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn danger" disabled={data === null || busy} onClick={() => void remove()}>
            {busy ? "Removing…" : "Remove for good"}
          </button>
        </div>
      </div>
    </div>
  );
}

// One line about data an older Atrium left, with the way to remove it. Home's copy can be put off; Settings' can't.
export function OldDataNotice({ dismissable = false }: { dismissable?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="old-data" role="note">
      <Archive />
      <span>An older Atrium left mail, texting, money and investing data on this Mac.</span>
      <button className="btn" onClick={() => setOpen(true)}>
        Remove old data
      </button>
      {dismissable && (
        <button className="btn link" onClick={() => void post("/api/old-data/dismiss")}>
          Not now
        </button>
      )}
      {open && <RemoveOldData onClose={() => setOpen(false)} />}
    </div>
  );
}
