import { MoreHorizontal, Plus, X } from "lucide-react";
import { useState } from "react";
import { del, patch, post } from "../../api";
import { investPath, openSymbol, type ListsView } from "../../simple";
import { PriceRow } from "./PriceRow";
import { SymbolSearch } from "./SymbolSearch";

export function Watchlists({ spaceId, view, initialList }: { spaceId: string; view: ListsView; initialList?: string }) {
  const [picked, setPicked] = useState<string | null>(initialList ?? null);
  const [naming, setNaming] = useState<"new" | "rename" | null>(null);
  const [name, setName] = useState("");
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = view.lists.find((l) => l.id === picked) ?? view.lists[0];
  const base = investPath(spaceId);

  const saveName = async () => {
    const res =
      naming === "new"
        ? await post<{ id: string }>(`${base}/lists`, { name })
        : await patch(`${base}/lists/${encodeURIComponent(list!.id)}`, { name });
    if (!res.ok) return setError(res.error);
    if (naming === "new") setPicked((res.data as { id: string }).id);
    setNaming(null);
    setName("");
    setError(null);
  };
  const removeList = async () => {
    const res = await del(`${base}/lists/${encodeURIComponent(list!.id)}`);
    setConfirm(false);
    setMenu(false);
    if (!res.ok) return setError(res.error);
    setPicked(null);
    setError(null);
  };
  const removeItem = async (key: string) => {
    const res = await del(`${base}/lists/${encodeURIComponent(list!.id)}/items/${encodeURIComponent(key)}`);
    setError(res.ok ? null : res.error);
  };

  return (
    <section className="inv-lists">
      <SymbolSearch spaceId={spaceId} lists={[...(list ? [list] : []), ...view.lists.filter((l) => l.id !== list?.id)]} />
      <div className="wl-bar">
        <div className="wl-chips" role="tablist" aria-label="Watchlists">
          {view.lists.map((l) => (
            <button key={l.id} role="tab" aria-selected={l.id === list?.id} className="wl-chip" onClick={() => setPicked(l.id)}>
              {l.name}
              <span className="wl-count">{l.rows.length}</span>
            </button>
          ))}
          {naming ? (
            <form
              className="wl-name"
              onSubmit={(e) => {
                e.preventDefault();
                void saveName();
              }}
            >
              <input autoFocus value={name} maxLength={60} placeholder={naming === "new" ? "List name" : list?.name} aria-label="List name" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setNaming(null)} />
              <button className="btn p" type="submit">
                {naming === "new" ? "Create" : "Rename"}
              </button>
              <button className="btn link" type="button" onClick={() => setNaming(null)}>
                Cancel
              </button>
            </form>
          ) : (
            <button className="wl-chip wl-new" onClick={() => setNaming("new")}>
              <Plus aria-hidden />
              New list
            </button>
          )}
        </div>
        {list && (
          <span className="wl-menu-wrap">
            <button className="icon-btn" aria-label={`Options for ${list.name}`} aria-expanded={menu} onClick={() => setMenu(!menu)}>
              <MoreHorizontal />
            </button>
            {menu && (
              <span className="srch-menu wl-menu" role="menu">
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    setName(list.name);
                    setNaming("rename");
                  }}
                >
                  Rename
                </button>
                <button role="menuitem" className="danger" onClick={() => setConfirm(true)}>
                  Delete list
                </button>
              </span>
            )}
          </span>
        )}
      </div>
      {confirm && list && (
        <div className="wl-confirm">
          <span>Delete "{list.name}"? Its symbols stay in your other lists.</span>
          <button className="btn danger" onClick={() => void removeList()}>
            Delete list
          </button>
          <button className="btn" onClick={() => setConfirm(false)}>
            Keep it
          </button>
        </div>
      )}
      {error && <p className="err">{error}</p>}
      {list && list.rows.length === 0 ? (
        <div className="inv-empty">
          <p>Nothing here yet. Search above to add a stock or ETF.</p>
        </div>
      ) : (
        <div className="inv-list wl-rows">
          {list?.rows.map((r) => (
            <PriceRow
              key={r.key}
              row={r}
              onOpen={() => openSymbol(spaceId, r.key)}
              actions={
                <span className="inv-row-acts">
                  <button className="icon-btn" aria-label={`Remove ${r.key} from ${list.name}`} title={`Remove ${r.key} from ${list.name}`} onClick={() => void removeItem(r.key)}>
                    <X />
                  </button>
                </span>
              }
            />
          ))}
        </div>
      )}
    </section>
  );
}
