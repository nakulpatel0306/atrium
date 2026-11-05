import { useState } from "react";
import { STAGES, type Idea, type Stage } from "../../../engine/markets/ideas";
import { put } from "../../api";
import { relative } from "../../format";
import { investingPath, useIdeas } from "../../investing";
import { Screener } from "./Screener";

const TITLE: Record<Stage, string> = { watching: "Watching", researching: "Researching", owned: "Owned", sold: "Sold" };

function Card({ spaceId, idea, onOpen }: { spaceId: string; idea: Idea; onOpen: (key: string) => void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState(idea.note);
  const [error, setError] = useState<string | null>(null);
  const save = (patch: { stage?: Stage; note?: string }) =>
    void put(`${investingPath(spaceId)}/ideas/${encodeURIComponent(idea.key)}`, patch).then((r) => setError(r.ok ? null : r.error));
  return (
    <div className={`idea-card${open ? " open" : ""}`}>
      <div className="idea-top" role="button" tabIndex={0} onClick={() => setOpen(!open)} onKeyDown={(e) => e.key === "Enter" && setOpen(!open)}>
        <b>{idea.key}</b>
        <span className="faint">{idea.stored ? relative(idea.stageAt) : "on the watchlist"}</span>
      </div>
      {idea.note && !open && <p className="idea-note">{idea.note}</p>}
      {open && (
        <div className="idea-edit">
          <select className="pick" value={idea.stage} onChange={(e) => save({ stage: e.target.value as Stage })}>
            {STAGES.map((s) => (
              <option key={s} value={s}>
                {TITLE[s]}
              </option>
            ))}
          </select>
          <textarea className="mk-input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why it's here" />
          <div className="mk-form">
            <button className="btn" onClick={() => save({ note })}>
              Save note
            </button>
            <button className="btn" onClick={() => onOpen(idea.key)}>
              Research
            </button>
          </div>
          {error && <span className="err">{error}</span>}
        </div>
      )}
    </div>
  );
}

export function Ideas({ spaceId, onOpen }: { spaceId: string; onOpen: (key: string) => void }) {
  const ideas = useIdeas(spaceId);
  return (
    <>
      <section>
        <h2>Idea pipeline</h2>
        <div className="ideas">
          {STAGES.map((stage) => {
            const col = (ideas ?? []).filter((i) => i.stage === stage);
            return (
              <div key={stage} className="idea-col">
                <div className="idea-col-head">
                  {TITLE[stage]} <span className="faint">{col.length}</span>
                </div>
                {col.map((i) => (
                  <Card key={i.key} spaceId={spaceId} idea={i} onOpen={onOpen} />
                ))}
                {col.length === 0 && <div className="faint idea-empty">Nothing here</div>}
              </div>
            );
          })}
        </div>
      </section>
      <Screener spaceId={spaceId} onOpen={onOpen} />
    </>
  );
}
