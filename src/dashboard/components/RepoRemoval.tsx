import { useState } from "react";
import { post, type State } from "../api";
import { removalSize } from "../repos";

type Approval = State["approvals"][number];

const CHECKED =
  "Checked just now, and again right before deleting: no uncommitted changes, no untracked files, no ignored files beyond build output, no .env files, no stash or extra worktrees, and every commit is on GitHub.";

export function RemovalRow({ approval }: { approval: Approval }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const size = removalSize(approval.detail);
  const decide = async (decision: "approve" | "reject") => {
    setBusy(true);
    setError(null);
    const res = await post(`/api/approvals/${approval.id}`, { decision });
    if (!res.ok) {
      setError(res.error);
      setBusy(false);
    }
  };
  return (
    <div className="entry">
      <div className="item">
        <span className="sd" style={{ background: "var(--accent)" }} />
        <span className="who">Atrium</span>
        <span className="t">
          {approval.title}
          {size && <span>{size}</span>}
        </span>
        <div className="acts">
          <button className="btn" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? "Hide" : "View"}
          </button>
          <button className="btn" disabled={busy} onClick={() => void decide("reject")}>
            Keep it
          </button>
          <button className="btn p" disabled={busy} onClick={() => void decide("approve")}>
            Remove copy
          </button>
        </div>
      </div>
      {open && (
        <div className="detail">
          <pre>{approval.detail}</pre>
          <div className="meta">
            <span>{CHECKED}</span>
          </div>
        </div>
      )}
      {error && <div className="row-err err">{error}</div>}
    </div>
  );
}
