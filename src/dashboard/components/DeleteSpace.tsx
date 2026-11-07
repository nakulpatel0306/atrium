import { Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { del, useFetched } from "../api";
import { nameMatches, type SpaceDeletePreview, spaceDeleteLines } from "../deletion";
import { showToast } from "../toast";

type Props = { space: { id: string; name: string }; onClose: () => void; onDeleted?: () => void };

// Permanent, so the guard is typing the space's name. The list comes from the engine's own count of what goes.
export function DeleteSpace({ space, onClose, onDeleted }: Props) {
  const preview = useFetched<SpaceDeletePreview>(`/api/spaces/${encodeURIComponent(space.id)}/delete-preview`, space.id);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const ready = nameMatches(typed, space.name) && preview !== null && preview.refusal === null;
  const remove = async () => {
    setBusy(true);
    setError(null);
    const res = await del<{ name: string; message: string; kept: string[] }>(`/api/spaces/${encodeURIComponent(space.id)}`, { name: typed });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    showToast([res.data.message, ...res.data.kept.slice(0, 1)].join(" "));
    onDeleted?.();
    onClose();
  };
  const lines = preview ? spaceDeleteLines(preview) : null;

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-title"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) void remove();
        }}
      >
        <h3 id="delete-title">
          <Trash2 />
          Delete "{space.name}" for good?
        </h3>
        {!lines ? (
          <p className="hint">Counting what's in it…</p>
        ) : (
          <>
            <p className="dialog-lead">This removes:</p>
            <ul className="goes">
              {lines.goes.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
            {lines.stays.length > 0 && (
              <ul className="stays">
                {lines.stays.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            )}
            {preview!.refusal && <p className="err">{preview!.refusal}</p>}
          </>
        )}
        <label className="confirm-name">
          <span>
            Type <b>{space.name}</b> to confirm. This can't be undone.
          </span>
          <input ref={input} value={typed} onChange={(e) => setTyped(e.target.value)} spellCheck={false} autoComplete="off" aria-label="Space name" />
        </label>
        {error && <p className="err">{error}</p>}
        <div className="dialog-acts">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn danger" disabled={!ready || busy}>
            {busy ? "Deleting…" : "Delete forever"}
          </button>
        </div>
      </form>
    </div>
  );
}
