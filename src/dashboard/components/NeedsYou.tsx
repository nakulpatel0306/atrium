import { Inbox, SearchCheck, Wrench } from "lucide-react";
import { useState } from "react";
import { post, type State, useMessages } from "../api";
import { absolute, firstLine, relative } from "../format";
import { navigate } from "../route";
import { reviewLine, reviewTarget } from "../summary";
import { ProposalRow } from "./Proposal";
import { AdviceTag } from "./markets/AdviceTag";

type Approval = State["approvals"][number];
type Space = State["spaces"][number];
// The second agent's part in this approval; the thread is read only once the verdict is in it.
const useReview = (approval: Approval, state: State) =>
  reviewLine(approval, state, useMessages(reviewTarget(approval, state)));

function Row({ approval, space, state }: { approval: Approval; space: Space | undefined; state: State }) {
  const [open, setOpen] = useState(false);
  const [sendingBack, setSendingBack] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const review = useReview(approval, state);
  const alert = approval.kind === "alert";
  // An agent's flag isn't one of Nakul's alerts, so there's nothing to turn off.
  const ownAlert = alert && !/ flagged /.test(approval.title);
  const turnOff = async () => {
    setBusy(true);
    const res = await post(`/api/markets/${approval.spaceId}/alerts/off-from-approval`, { approvalId: approval.id });
    if (res.ok) await decide("approve");
    else {
      setError(res.error);
      setBusy(false);
    }
  };
  const ReviewIcon = review?.fixing ? Wrench : SearchCheck;

  const decide = async (decision: "approve" | "reject") => {
    setBusy(true);
    setError(null);
    const res = await post(`/api/approvals/${approval.id}`, {
      decision,
      ...(decision === "reject" && note.trim() ? { note: note.trim() } : {}),
    });
    // On success the row disappears with the next state refresh.
    if (!res.ok) {
      setError(res.error);
      setBusy(false);
    }
  };

  return (
    <div className="entry">
      <div className="item">
        <span className="sd" style={{ background: space?.color ?? "var(--faint)" }} />
        <span className="who">{space?.name ?? "Unknown space"}</span>
        <span className="t">
          {approval.title}
          {approval.detail && <span>{firstLine(approval.detail)}</span>}
        </span>
        {review && (
          <span className={`review-line${review.tone ? ` ${review.tone}` : ""}`} title={review.text}>
            <ReviewIcon />
            {review.text}
          </span>
        )}
        {space?.kind === "markets" && <AdviceTag />}
        <div className="acts">
          <button className="btn" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? "Hide" : "View"}
          </button>
          {alert ? (
            <>
              {ownAlert && (
                <button className="btn link" disabled={busy} onClick={() => void turnOff()}>
                  Turn off alert
                </button>
              )}
              <button className="btn p" disabled={busy} onClick={() => void decide("approve")}>
                Dismiss
              </button>
            </>
          ) : (
            <>
              <button className="btn" disabled={busy} onClick={() => setSendingBack(!sendingBack)}>
                Send back
              </button>
              <button className="btn p" disabled={busy} onClick={() => void decide("approve")}>
                Approve
              </button>
            </>
          )}
        </div>
      </div>
      {open && (
        <div className="detail">
          <pre>{approval.detail || "No further detail."}</pre>
          <div className="meta">
            <span title={absolute(approval.createdAt)}>Asked {relative(approval.createdAt)}</span>
            {approval.taskId && space && (
              // Runs and their transcripts are listed per task in the space view.
              <a
                href={`/space/${space.id}?task=${approval.taskId}`}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(`/space/${space.id}?task=${approval.taskId}`);
                }}
              >
                View transcript in {space.name}
              </a>
            )}
          </div>
        </div>
      )}
      {sendingBack && !alert && (
        <form
          className="note"
          onSubmit={(e) => {
            e.preventDefault();
            void decide("reject");
          }}
        >
          <input
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setSendingBack(false)}
            placeholder="What should change? (a short note for the agent)"
          />
          <button className="btn" type="button" onClick={() => setSendingBack(false)}>
            Cancel
          </button>
          <button className="btn p" type="submit" disabled={busy}>
            Send back
          </button>
        </form>
      )}
      {error && <div className="row-err err">{error}</div>}
    </div>
  );
}

export function NeedsYou({ state }: { state: State }) {
  const spaces = new Map(state.spaces.map((s) => [s.id, s]));
  const count = state.approvals.length + state.proposals.length;
  return (
    <>
      <h2 id="needs">
        <Inbox />
        Needs you{count > 0 && ` · ${count}`}</h2>
      <div className="list">
        {count === 0 ? (
          <div className="empty-row">You're all caught up.</div>
        ) : (
          <>
            {state.proposals.map((p) => (
              <ProposalRow key={p.id} proposal={p} space={spaces.get(p.spaceId)} />
            ))}
            {state.approvals.map((a) => (
              <Row key={a.id} approval={a} space={a.spaceId ? spaces.get(a.spaceId) : undefined} state={state} />
            ))}
          </>
        )}
      </div>
    </>
  );
}
