import { useState } from "react";
import type { State } from "../api";
import { absolute, relative } from "../format";

type Row = State["activity"][number];

const actorName = (actor: string) => (actor === "you" ? "You" : actor.charAt(0).toUpperCase() + actor.slice(1));

function Item({ row, spaceName }: { row: Row; spaceName: string | undefined }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`item${open ? " open" : ""}`} onClick={() => setOpen(!open)}>
      <span className="tm" title={absolute(row.createdAt)}>
        {relative(row.createdAt)}
      </span>
      <span className="msg">
        <span className="src">
          {actorName(row.actor)}
          {spaceName && ` · ${spaceName}`}
        </span>
        : {row.message}
      </span>
    </div>
  );
}

// With a spaceId, shows only that space's rows and drops the space name each row would repeat.
export function Activity({ state, spaceId }: { state: State; spaceId?: string }) {
  const names = new Map(state.spaces.map((s) => [s.id, s.name]));
  const rows = spaceId ? state.activity.filter((r) => r.spaceId === spaceId) : state.activity;
  return (
    <>
      <h2 id="activity">Activity</h2>
      <div className="list feed">
        {rows.length === 0 ? (
          <div className="empty-row">No activity yet. Agent runs and your decisions will show up here.</div>
        ) : (
          rows.map((r) => (
            <Item key={r.id} row={r} spaceName={!spaceId && r.spaceId ? names.get(r.spaceId) : undefined} />
          ))
        )}
      </div>
    </>
  );
}
