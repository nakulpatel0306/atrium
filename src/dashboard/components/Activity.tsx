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

export function Activity({ state }: { state: State }) {
  const names = new Map(state.spaces.map((s) => [s.id, s.name]));
  return (
    <>
      <h2 id="activity">Activity</h2>
      <div className="list feed">
        {state.activity.length === 0 ? (
          <div className="empty-row">No activity yet. Agent runs and your decisions will show up here.</div>
        ) : (
          state.activity.map((r) => (
            <Item key={r.id} row={r} spaceName={r.spaceId ? names.get(r.spaceId) : undefined} />
          ))
        )}
      </div>
    </>
  );
}
