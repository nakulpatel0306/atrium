import { Search } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { patch, post, type State } from "../api";
import { matchActions, type PaletteAction, paletteActions } from "../palette";
import { navigate } from "../route";
import { applyTheme, storedTheme } from "../theme";
import { useDialogFocus } from "../focus";
import { showToast } from "../toast";
import { reopen } from "./Decision";

const SHOWN = 60;

// ⌘K: every action by name. Typing narrows, the arrow keys pick, Enter runs, Esc closes. What an action does is
// decided in palette.ts; this only carries it out.
export function Palette({ state, spaceId, open, onClose, onAsk, onNewSpace }: { state: State; spaceId: string | null; open: boolean; onClose: () => void; onAsk: () => void; onNewSpace: () => void }) {
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const actions = useMemo(() => (open ? paletteActions(state, { spaceId, theme: storedTheme() }) : []), [open, state, spaceId]);
  const found = useMemo(() => matchActions(actions, query).slice(0, SHOWN), [actions, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setAt(0);
    setError(null);
    requestAnimationFrame(() => input.current?.focus());
  }, [open]);
  useEffect(() => {
    setAt(0);
  }, [query]);
  useEffect(() => {
    document.getElementById(`pal-${found[at]?.id}`)?.scrollIntoView({ block: "nearest" });
  }, [at, found]);

  if (!open) return null;

  const run = async (a: PaletteAction) => {
    const r = a.run;
    if (r.kind === "navigate") navigate(r.path);
    else if (r.kind === "ask") onAsk();
    else if (r.kind === "newSpace") onNewSpace();
    else if (r.kind === "theme") applyTheme(r.theme);
    else {
      const res = r.kind === "post" ? await post(r.path, r.body) : await patch(r.path, r.body);
      if (!res.ok) return setError(res.error);
      // An approval made here can be taken back like one made on its screen.
      if (r.kind === "post" && r.undo) showToast(r.done, () => reopen(r.undo!), state.approvals.find((a) => a.id === r.undo)?.taskId ?? undefined);
      else showToast(r.done);
    }
    onClose();
  };

  return (
    <div className="palette-scrim" onMouseDown={onClose}>
      <PaletteBox onClose={onClose}>
        <label className="palette-input">
          <Search />
          <input
            ref={input}
            value={query}
            placeholder="Type a command, a space or a task"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={found[at] ? `pal-${found[at]!.id}` : undefined}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              else if (e.key === "ArrowDown") {
                e.preventDefault();
                setAt((i) => Math.min(found.length - 1, i + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setAt((i) => Math.max(0, i - 1));
              } else if (e.key === "Enter" && found[at]) {
                e.preventDefault();
                void run(found[at]!);
              }
            }}
          />
        </label>
        <ul className="palette-list" id="palette-list" role="listbox" aria-label="Commands">
          {found.length === 0 && <li className="palette-empty">Nothing matches. Try a space's name, a task, or "settings".</li>}
          {found.map((a, i) => (
            <li key={a.id} id={`pal-${a.id}`} role="option" aria-selected={i === at} className={i === at ? "on" : ""} onMouseMove={() => setAt(i)} onClick={() => void run(a)}>
              <span className="palette-group">{a.group}</span>
              <span className="palette-label">{a.label}</span>
              {a.hint && <span className="palette-hint">{a.hint}</span>}
            </li>
          ))}
        </ul>
        {error && <p className="err palette-err">{error}</p>}
      </PaletteBox>
    </div>
  );
}

// The palette's box, mounted only while it's open, so its focus trap starts on opening and gives focus back on closing.
// The input's own Escape closes it, so the trap leaves Escape alone.
function PaletteBox({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useDialogFocus(box, onClose, { escape: false });
  return (
    <div ref={box} className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}>
      {children}
    </div>
  );
}
