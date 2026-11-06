import { X } from "lucide-react";
import { useState } from "react";
import { dismissToast, showToast, useToast } from "../toast";

export function Toast() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!toast) return null;
  const undo = async () => {
    setBusy(true);
    const res = await toast.undo!();
    setBusy(false);
    if (res.ok) dismissToast();
    else showToast(res.error ?? "Atrium couldn't undo that. Try again from Settings.");
  };
  return (
    <div className="toast" role="status" key={toast.id}>
      <span>{toast.text}</span>
      {toast.undo && (
        <button className="btn" disabled={busy} onClick={() => void undo()}>
          Undo
        </button>
      )}
      <button className="toast-x" aria-label="Dismiss" onClick={dismissToast}>
        <X />
      </button>
    </div>
  );
}
