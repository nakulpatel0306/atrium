import { Inbox, SearchCheck, Wrench } from "lucide-react";
import { useState } from "react";
import { agentName, ranAgent, verdictOf } from "../agents";
import { post, type State, useMessages } from "../api";
import { absolute, firstLine, relative } from "../format";
import { navigate } from "../route";
import { ProposalRow } from "./Proposal";
import { AdviceTag } from "./markets/AdviceTag";

type Approval = State["approvals"][number];
type Space = State["spaces"][number];
type Task = State["tasks"][number];
type Review = { text: string; tone?: "ok" | "waiting" | "bad"; fixing: boolean };

const FIX_STATE: Partial<Record<Task["status"], string>> = {
  queued: "fix in progress",
  running: "fix in progress",
  done: "fixed",
  failed: "fix didn't finish",
  blocked: "fix didn't finish",
};

// The second agent's part in this approval, as one line; null when the space doesn't review.
function useReview(approval: Approval, state: State): Review | null {
  const children = approval.taskId ? state.tasks.filter((t) => t.parentTaskId === approval.taskId) : [];
  const review = children.find((t) => t.kind === "review");
  const fix = children.find((t) => t.kind === "fix");
  const messages = useMessages(review?.status === "done" ? approval.taskId : null);
  if (!review) return null;
  const who = agentName(review.agent);
  if (review.status !== "done") return { text: `${who} is reviewing · you can decide now`, tone: "waiting", fixing: false };
  if (fix) {
    const worker = agentName(ranAgent(fix, state.runs));
    const step = FIX_STATE[fix.status] ?? "fix in progress";
    return { text: `${who} asked for changes · ${step === "fixed" ? `${worker} fixed them` : step}`, tone: "waiting", fixing: true };
  }
  if (!messages) return { text: `Reviewed by ${who}`, fixing: false };
  const said = messages.filter((m) => m.fromAgent === review.agent).at(-1);
  if (!said) return { text: `${who}'s review didn't happen · decide as usual`, tone: "bad", fixing: false };
  const verdict = verdictOf(said.body);
  if (verdict === "approve") return { text: `Reviewed by ${who} · approve`, tone: "ok", fixing: false };
  if (verdict === "changes") return { text: `${who} asked for changes`, tone: "waiting", fixing: false };
  return { text: `Reviewed by ${who} · no verdict, see the thread`, fixing: false };
}

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
              <Row key={a.id} approval={a} space={spaces.get(a.spaceId)} state={state} />
            ))}
          </>
        )}
      </div>
    </>
  );
}
