import { BookOpen, HelpCircle } from "lucide-react";
import { useState } from "react";
import { type Spot, predictOpen } from "../../engine/walkthrough";
import { agentName } from "../agents";
import { post, type State } from "../api";
import { navigate } from "../route";

type Task = State["tasks"][number];
type Space = State["spaces"][number];

// Where a file:line opens: the task's Changes, at the hunk that holds the line.
export const spotLink = (task: Task, s: Spot) => `/space/${task.spaceId}?task=${task.id}&view=changes&file=${encodeURIComponent(s.file)}${s.line ? `&line=${s.line}` : ""}`;

const where = (s: Spot) => `${s.file}${s.line ? `:${s.line}` : ""}`;

// Whether a task has a walkthrough to show, or one still to come: a finished code task in a space with learning on.
export const walkthroughFor = (task: Task, space: Space | undefined): boolean =>
  space?.kind === "repo" && space.learning !== "off" && task.kind === "work" && !!task.loop && !task.loop.role && !task.loop.noChanges && (task.status === "review" || task.status === "done");

// Deep mode's question before the walkthrough: one click on an answer, or Skip. Nothing is scored.
function Predict({ task }: { task: Task }) {
  const p = task.loop!.walkthrough!.predict!;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answer = async (guess: number | null) => {
    setBusy(true);
    const res = await post(`/api/tasks/${task.id}/predict`, { guess });
    setBusy(false);
    if (!res.ok) setError(res.error);
  };
  return (
    <div className="predict">
      <p>
        <HelpCircle />
        Before you read it: {p.question}
      </p>
      <div className="acts">
        {p.options.map((o, i) => (
          <button key={i} className="btn" disabled={busy} onClick={() => void answer(i)}>
            {o}
          </button>
        ))}
        <button className="btn link subtle" disabled={busy} onClick={() => void answer(null)}>
          Skip
        </button>
      </div>
      {error && <p className="err">{error}</p>}
    </div>
  );
}

function Spots({ task, title, spots }: { task: Task; title: string; spots: Spot[] }) {
  if (!spots.length) return null;
  return (
    <div>
      <h5>{title}</h5>
      <ul>
        {spots.map((s, i) => (
          <li key={i}>
            {s.file && (
              <button className="btn link mono" onClick={() => navigate(spotLink(task, s))}>
                {where(s)}
              </button>
            )}{" "}
            {s.note}
          </li>
        ))}
      </ul>
    </div>
  );
}

// The walkthrough of a finished change, above its diff: the approach, the decisions and what they passed over, risky
// spots, and where to look first, each spot opening the Changes at its hunk. Short, optional, never in the way.
export function WalkthroughCard({ task, space }: { task: Task; space: Space | undefined }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!walkthroughFor(task, space)) return null;
  const w = task.loop!.walkthrough;
  const stale = w !== null && w.sha !== task.loop!.checkedSha;
  const write = async () => {
    setBusy(true);
    setError(null);
    const res = await post(`/api/tasks/${task.id}/walkthrough`);
    setBusy(false);
    if (!res.ok) setError(res.error);
  };
  const again = (label: string) => (
    <button className="btn" disabled={busy} onClick={() => void write()}>
      {busy ? "Writing…" : label}
    </button>
  );
  if (!w) {
    // A result from before learning was on, or one already decided, doesn't need one any more.
    if (task.status !== "review") return null;
    return (
      // One line, not a card: an empty walkthrough shouldn't take the room the diff below needs.
      <p className="walkthrough-empty hint">
        <BookOpen />
        Walkthrough not written yet; it's usually on its way as the result arrives. {again("Write it now")}
        {error && <span className="err"> {error}</span>}
      </p>
    );
  }
  const p = w.predict;
  return (
    <section className="walkthrough">
      <h4>
        <BookOpen />
        Walkthrough
        <span className="hint">by {agentName(w.by)}{w.source === "review" ? ", in its review" : ""}</span>
      </h4>
      {predictOpen(w) ? (
        <Predict task={task} />
      ) : (
        <>
          {p && p.guess !== null && (
            <p className={`predicted${p.guess === p.answer ? " right" : ""}`}>
              {p.guess === p.answer ? `You called it: ${p.options[p.answer]}` : `You picked "${p.options[p.guess]}". It's: ${p.options[p.answer]}`}
            </p>
          )}
          {stale && <p className="hint">Written before the last turn changed the branch. {again("Write it again")}</p>}
          <p>{w.approach}</p>
          {w.decisions.length > 0 && (
            <div>
              <h5>Decisions</h5>
              <ul>
                {w.decisions.map((d, i) => (
                  <li key={i}>
                    {d.chose}
                    {d.rejected && <span className="hint"> · over {d.rejected}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <Spots task={task} title="Spots to check" spots={w.risks} />
          <Spots task={task} title="Where to look first" spots={w.look} />
        </>
      )}
      {error && <p className="err">{error}</p>}
    </section>
  );
}
