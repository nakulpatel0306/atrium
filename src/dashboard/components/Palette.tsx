import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { patch, post, type State } from "../api";
import { matchActions, type PaletteAction, paletteActions } from "../palette";
import { navigate } from "../route";
import { applyTheme, storedTheme } from "../theme";
import { showToast } from "../toast";

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
  useEffect(() => setAt(0), [query]);
  useEffect(() => document.getElementById(`pal-${found[at]?.id}`)?.scrollIntoView({ block: "nearest" }), [at, found]);

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
      showToast(r.done);
    }
    onClose();
  };

  return (
    <div className="palette-scrim" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}>
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
      </div>
    </div>
  );
}
