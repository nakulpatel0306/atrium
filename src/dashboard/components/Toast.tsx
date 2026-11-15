import { X } from "lucide-react";
import { useState } from "react";
import { dismissToast, showToast, type Toast as T, useToasts } from "../toast";

function One({ toast }: { toast: T }) {
  const [busy, setBusy] = useState(false);
  const undo = async () => {
    if (!toast.undo) return;
    setBusy(true);
    const res = await toast.undo();
    setBusy(false);
    dismissToast(toast.id);
    if (!res.ok) showToast(res.error ?? "Atrium couldn't take that back. Ask for the change again as a new task.");
  };
  return (
    <div className="toast">
      <span>{toast.text}</span>
      {toast.undo && (
        <button className="btn" disabled={busy} onClick={() => void undo()}>
          Undo
        </button>
      )}
      <button className="toast-x" aria-label="Dismiss" onClick={() => dismissToast(toast.id)}>
        <X />
      </button>
    </div>
  );
}

export function Toast() {
  const toasts = useToasts();
  // The status region stays mounted so screen readers hear each toast as it arrives.
  return (
    <div role="status" aria-live="polite" className="toasts">
      {toasts.map((t) => (
        <One key={t.id} toast={t} />
      ))}
    </div>
  );
}
