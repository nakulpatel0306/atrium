import { Settings2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { put } from "../../api";
import { investPath } from "../../simple";

const HINT = "Look-through, TFSA, ideas, screener, paper trading, indicator alerts and the data budget. Off keeps them saved and stops their background work.";

export function AdvancedToggleView({
  on,
  open,
  busy,
  error,
  onToggle,
  onOpen,
}: {
  on: boolean;
  open: boolean;
  busy: boolean;
  error: string | null;
  onToggle: () => void;
  onOpen: () => void;
}) {
  return (
    <div className="adv">
      <button className="icon-btn" aria-label="Investing settings" aria-expanded={open} title="Investing settings" onClick={onOpen}>
        <Settings2 />
      </button>
      {open && (
        <div className="adv-pop" role="dialog" aria-label="Investing settings">
          <button className="toggle" role="switch" aria-checked={on} disabled={busy} onClick={onToggle}>
            <span className="switch" />
            Advanced tools
          </button>
          <p className="hint">{HINT}</p>
          {error && <p className="err">{error}</p>}
        </div>
      )}
    </div>
  );
}

export function AdvancedToggle({ spaceId, on }: { spaceId: string; on: boolean }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    addEventListener("mousedown", close);
    addEventListener("keydown", close);
    return () => {
      removeEventListener("mousedown", close);
      removeEventListener("keydown", close);
    };
  }, [open]);
  const toggle = async () => {
    setBusy(true);
    const res = await put(`${investPath(spaceId)}/advanced`, { on: !on });
    setBusy(false);
    setError(res.ok ? null : res.error);
  };
  return (
    <div ref={box}>
      <AdvancedToggleView on={on} open={open} busy={busy} error={error} onToggle={() => void toggle()} onOpen={() => setOpen(!open)} />
    </div>
  );
}
