import { Sparkles } from "lucide-react";
import { useState } from "react";
import { post, type State } from "../api";
import { absolute, relative } from "../format";

type Proposal = State["proposals"][number];
type Space = State["spaces"][number];

// "Stop asking about this?" Only Nakul's yes here turns a habit into a rule.
export function ProposalRow({ proposal, space }: { proposal: Proposal; space: Space | undefined }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const answer = async (value: "yes" | "not_now" | "never") => {
    setBusy(true);
    setError(null);
    const res = await post(`/api/proposals/${proposal.id}`, { answer: value });
    // On success the row disappears with the next state refresh.
    if (!res.ok) {
      setError(res.error);
      setBusy(false);
    }
  };

  return (
    <div className="entry">
      <div className="item suggestion">
        <span className="sd" style={{ background: space?.color ?? "var(--faint)" }} />
        <span className="who">{space?.name ?? "Unknown space"}</span>
        <Sparkles className="spark" />
        <span className="t">
          Stop asking about {proposal.label}?<span>You approved the last {proposal.evidence.length} without changes.</span>
        </span>
        <div className="acts">
          <button className="btn" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? "Hide" : "View"}
          </button>
          <button className="btn" disabled={busy} onClick={() => void answer("never")}>
            Never
          </button>
          <button className="btn" disabled={busy} onClick={() => void answer("not_now")}>
            Not now
          </button>
          <button className="btn p" disabled={busy} onClick={() => void answer("yes")}>
            Yes
          </button>
        </div>
      </div>
      {open && (
        <div className="detail">
          <p className="role">
            If you say yes, Atrium approves these in {space?.name ?? "this space"} on its own from now on. It never merges or
            pushes, each one shows up in Activity, and you can undo any of them or turn the rule off on the Rules page. It
            still always asks before merging, deploying, deleting, messaging someone new, spending money, or touching secrets.
          </p>
          <ul className="runs evidence">
            {proposal.evidence.map((e) => (
              <li key={e.id}>
                <span className="task-link">{e.title}</span>
                <span title={absolute(e.resolvedAt)}>approved {relative(e.resolvedAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && <div className="row-err err">{error}</div>}
    </div>
  );
}
