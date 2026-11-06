import { ChevronDown, Search } from "lucide-react";
import { useState } from "react";
import type { SearchHit } from "../../../engine/markets/providers/types";
import { post } from "../../api";
import { investPath, openSymbol, useSearch, type SearchResult } from "../../simple";

type ListRef = { id: string; name: string };
const TYPE_TEXT: Record<string, string> = { "Common Stock": "Stock", ETP: "ETF", ETF: "ETF", ADR: "ADR", REIT: "REIT", typed: "Typed symbol" };

function HitRow({ hit, lists, active, onOpen, onAdd }: { hit: SearchHit; lists: ListRef[]; active: boolean; onOpen: () => void; onAdd: (listId: string) => void }) {
  const [more, setMore] = useState(false);
  const [first, ...rest] = lists;
  return (
    <div className={`srch-hit${active ? " on" : ""}`} role="option" aria-selected={active}>
      <span className="srch-main">
        <span className="srch-sym">
          <b>{hit.key}</b>
          <span className="chip">{hit.exchange}</span>
        </span>
        <span className="srch-name">
          {hit.type === "typed" ? "" : `${hit.name} · `}
          <span className="faint">{TYPE_TEXT[hit.type] ?? hit.type}</span>
        </span>
        {hit.note && <span className="srch-note">{hit.note}</span>}
      </span>
      <span className="srch-acts">
        <button className="btn" onClick={onOpen}>
          Open
        </button>
        {first && (
          <span className="srch-add">
            <button className="btn" onClick={() => onAdd(first.id)}>
              Add to {first.name}
            </button>
            {rest.length > 0 && (
              <button className="btn srch-more" aria-label="Add to another list" aria-expanded={more} onClick={() => setMore(!more)}>
                <ChevronDown />
              </button>
            )}
            {more && (
              <span className="srch-menu" role="menu">
                {rest.map((l) => (
                  <button
                    key={l.id}
                    role="menuitem"
                    onClick={() => {
                      setMore(false);
                      onAdd(l.id);
                    }}
                  >
                    {l.name}
                  </button>
                ))}
              </span>
            )}
          </span>
        )}
      </span>
    </div>
  );
}

export function SearchResults({
  result,
  lists,
  active,
  onOpen,
  onAdd,
}: {
  result: SearchResult;
  lists: ListRef[];
  active: number;
  onOpen: (hit: SearchHit) => void;
  onAdd: (hit: SearchHit, listId: string) => void;
}) {
  return (
    <>
      {result.note && <p className="srch-msg">{result.note}</p>}
      {result.hits.length > 0 && (
        <div className="srch-list" role="listbox" aria-label="Search results">
          {result.hits.map((h, i) => (
            <HitRow key={h.key} hit={h} lists={lists} active={i === active} onOpen={() => onOpen(h)} onAdd={(id) => onAdd(h, id)} />
          ))}
        </div>
      )}
    </>
  );
}

export function SymbolSearch({ spaceId, lists, onPicked }: { spaceId: string; lists: ListRef[]; onPicked?: (key: string) => void }) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState(true);
  const [line, setLine] = useState<{ ok: boolean; text: string } | null>(null);
  const { result, error, busy } = useSearch(q);
  const hits = result?.hits ?? [];

  const openHit = (h: SearchHit) => {
    onPicked?.(h.key);
    openSymbol(spaceId, h.key);
  };
  const add = async (h: SearchHit, listId: string) => {
    const list = lists.find((l) => l.id === listId);
    const res = await post(`${investPath(spaceId)}/lists/${encodeURIComponent(listId)}/items`, { key: h.key, name: h.type === "typed" ? "" : h.name });
    setLine(res.ok ? { ok: true, text: `Added ${h.key} to ${list?.name ?? "the list"}.` } : { ok: false, text: res.error });
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(hits.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" && hits[active]) {
      openHit(hits[active]);
    } else if (e.key === "Escape") {
      setOpen(false);
      setActive(-1);
    }
  };
  return (
    <div className="srch">
      <label className="srch-box">
        <Search aria-hidden />
        <input
          type="search"
          value={q}
          placeholder="Search a stock or ETF, like Shopify or XEQT.TO"
          aria-label="Search a stock or ETF"
          aria-expanded={open && hits.length > 0}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
            setActive(-1);
            setLine(null);
          }}
          onKeyDown={onKey}
        />
        {busy && <span className="faint srch-busy">Searching…</span>}
      </label>
      {line && <p className={line.ok ? "ok-line srch-msg" : "err srch-msg"}>{line.text}</p>}
      {error && <p className="err srch-msg">{error}</p>}
      {open && result && <SearchResults result={result} lists={lists} active={active} onOpen={openHit} onAdd={(h, id) => void add(h, id)} />}
      {open && result && !result.note && hits.length === 0 && <p className="srch-msg">No US or Canadian stock or ETF matches "{q.trim()}".</p>}
    </div>
  );
}
