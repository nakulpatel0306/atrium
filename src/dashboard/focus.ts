import { type RefObject, useEffect, useRef } from "react";

// Everything Tab can stop on, including a <details> toggle and edited text; the first summary of a details is its toggle.
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  "details > summary:first-of-type",
  "audio[controls]",
  "video[controls]",
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

// A dialog's focus: Tab and Shift Tab go round its own controls rather than out to the page behind it, Escape closes
// it (unless the page already owns Escape, as Needs you does for its keys sheet), and on closing, focus goes back to
// whatever had it when the dialog opened.
export function useDialogFocus(box: RefObject<HTMLElement | null>, onClose: () => void, { escape = true } = {}): void {
  // Read when a key comes, so a new onClose each render doesn't reopen the trap and move focus.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKey = (e: KeyboardEvent) => {
      const el = box.current;
      if (!el) return;
      if (e.key === "Escape" && escape) {
        e.preventDefault();
        close.current();
        return;
      }
      if (e.key !== "Tab") return;
      const all = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!all.length) return;
      const first = all[0]!;
      const last = all.at(-1)!;
      const at = document.activeElement;
      if (!el.contains(at)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && (at === first || at === el)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && at === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (opener?.isConnected) opener.focus();
    };
  }, [box, escape]);
}
