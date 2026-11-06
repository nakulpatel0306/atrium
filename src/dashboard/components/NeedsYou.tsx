import { Inbox, SearchCheck, Wrench } from "lucide-react";
import { useState } from "react";
import { post, type State, useMessages } from "../api";
import { absolute, relative } from "../format";
import { navigate } from "../route";
import { reviewLine, reviewTarget, summaryLine } from "../summary";
import { MessageCard } from "./MessageCard";
import { approveLabel, OutcomeBanner } from "./OutcomeBanner";
import { ProjectDraftRow } from "./ProjectDraft";
import { ProposalRow } from "./Proposal";
import { RemovalRow } from "./RepoRemoval";
import { AdviceTag } from "./markets/AdviceTag";
import { Markdown } from "./Markdown";
import { WhatItMade } from "./WhatItMade";

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
  // What the agent said about a result that isn't plainly done; only reviews carry one.
  const task = approval.kind === "review" && approval.taskId ? state.tasks.find((t) => t.id === approval.taskId) : undefined;
  const outcome = task?.outcome && task.outcome !== "done" ? task.outcome : null;

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
        <span className="who">{space?.name ?? (approval.spaceId === null ? "Atrium" : "Unknown space")}</span>
        <span className="t" title={approval.detail ? `${approval.title}\n${summaryLine(approval.detail)}` : approval.title}>
          {approval.title}
          {approval.detail && <span>{summaryLine(approval.detail)}</span>}
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
                {approveLabel(outcome)}
              </button>
            </>
          )}
        </div>
      </div>
      {outcome && (
        <div className="outcome-row">
          <OutcomeBanner outcome={outcome} reason={task?.outcomeReason ?? null} />
        </div>
      )}
      {open && (
        <div className="detail">
          {approval.taskId && space ? (
            <WhatItMade taskId={approval.taskId} spaceId={space.id} spaceKind={space.kind} />
          ) : (
            <Markdown text={approval.detail || "No further detail."} />
          )}
          <div className="meta">
            <span title={absolute(approval.createdAt)}>Asked {relative(approval.createdAt)}</span>
            {approval.taskId && space && (
              // The task shows its runs, transcripts and files in full.
              <a
                href={`/space/${space.id}?task=${approval.taskId}`}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(`/space/${space.id}?task=${approval.taskId}`);
                }}
              >
                Open the task in {space.name}
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
            {state.approvals.map((a) => {
              const action = state.repoActions.find((r) => r.approvalId === a.id);
              if (a.alwaysAsk === "create_repo" && action?.draft) return <ProjectDraftRow key={a.id} approval={a} action={action} />;
              if (a.alwaysAsk === "remove_clone") return <RemovalRow key={a.id} approval={a} />;
              const text = a.alwaysAsk === "send_message" ? state.messageActions.find((m) => m.approvalId === a.id) : undefined;
              if (text) return <MessageCard key={a.id} approval={a} action={text} spaceName={spaces.get(text.spaceId)?.name} firstSend={state.messaging.state === "untested"} />;
              return <Row key={a.id} approval={a} space={a.spaceId ? spaces.get(a.spaceId) : undefined} state={state} />;
            })}
          </>
        )}
      </div>
    </>
  );
}
