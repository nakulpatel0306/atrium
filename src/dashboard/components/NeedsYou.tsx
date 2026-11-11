import { CalendarClock, Inbox, SearchCheck, Wrench } from "lucide-react";
import { useState } from "react";
import { post, type State, useMessages } from "../api";
import { absolute, relative } from "../format";
import { navigate } from "../route";
import { reviewLine, reviewTarget, summaryLine } from "../summary";
import { GroupMessageCard } from "./GroupMessageCard";
import { MessageCard } from "./MessageCard";
import { DecideButtons, SendBackNote, useDecision } from "./Decision";
import { OutcomeBanner } from "./OutcomeBanner";
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
  const d = useDecision(approval);
  const { busy, setBusy, error, setError, decide } = d;
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
          <button className="btn" data-act="open" onClick={() => setOpen(!open)} aria-expanded={open}>
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
            <DecideButtons d={d} outcome={outcome} />
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
      {!alert && <SendBackNote d={d} />}
      {error && <div className="row-err err">{error}</div>}
    </div>
  );
}

type Nudge = State["nudges"][number];

// The monthly "time to import" reminder: a quiet row, not something to approve, so it isn't counted.
function NudgeRow({ nudge }: { nudge: Nudge }) {
  const [error, setError] = useState<string | null>(null);
  const dismiss = async () => {
    const res = await post(`/api/investing/${encodeURIComponent(nudge.spaceId)}/money/nudges/${encodeURIComponent(nudge.id)}/dismiss`);
    if (!res.ok) setError(res.error);
  };
  return (
    <div className="row nudge-row">
      <CalendarClock className="nudge-icon" />
      <div className="nudge-text">
        <b>{nudge.title}</b>
        <span className="faint">{nudge.body}</span>
      </div>
      <button className="btn" onClick={() => navigate(nudge.path)}>
        Import now
      </button>
      <button className="btn link" onClick={() => void dismiss()}>
        Dismiss
      </button>
      {error && <div className="row-err err">{error}</div>}
    </div>
  );
}

// Every row waiting on Nakul, each with its own kind of answer. A space shows its share of the same rows.
function Items({ state, spaceId }: { state: State; spaceId?: string }) {
  const spaces = new Map(state.spaces.map((s) => [s.id, s]));
  const mine = <T extends { spaceId: string | null }>(xs: T[]) => (spaceId ? xs.filter((x) => x.spaceId === spaceId) : xs);
  return (
    <>
      {mine(state.proposals).map((p) => (
        <ProposalRow key={p.id} proposal={p} space={spaces.get(p.spaceId)} />
      ))}
      {mine(state.approvals).map((a) => {
        const action = state.repoActions.find((r) => r.approvalId === a.id);
        if (a.alwaysAsk === "create_repo" && action?.draft) return <ProjectDraftRow key={a.id} approval={a} action={action} />;
        if (a.alwaysAsk === "remove_clone") return <RemovalRow key={a.id} approval={a} />;
        const text = a.alwaysAsk === "send_message" ? state.messageActions.find((m) => m.approvalId === a.id) : undefined;
        const Card = text?.group ? GroupMessageCard : MessageCard;
        if (text) return <Card key={a.id} approval={a} action={text} spaceName={spaces.get(text.spaceId)?.name} firstSend={state.messaging.state === "untested"} />;
        return <Row key={a.id} approval={a} space={a.spaceId ? spaces.get(a.spaceId) : undefined} state={state} />;
      })}
    </>
  );
}

export const waitingIn = (state: State, spaceId: string) =>
  state.approvals.filter((a) => a.spaceId === spaceId).length + state.proposals.filter((p) => p.spaceId === spaceId).length;

// At the top of a space: what's waiting on Nakul there, answered right where the work is.
export function SpaceNeeds({ state, spaceId }: { state: State; spaceId: string }) {
  const count = waitingIn(state, spaceId);
  if (count === 0) return null;
  return (
    <>
      <h2>
        <Inbox />
        Waiting for you · {count}
      </h2>
      <div className="list needs-list">
        <Items state={state} spaceId={spaceId} />
      </div>
    </>
  );
}

export function NeedsYou({ state }: { state: State }) {
  const count = state.approvals.length + state.proposals.length;
  const nudges = state.nudges ?? [];
  return (
    <>
      <h2 id="needs">
        <Inbox />
        Needs you{count > 0 && ` · ${count}`}</h2>
      <div className="list needs-list">
        {nudges.map((n) => (
          <NudgeRow key={n.id} nudge={n} />
        ))}
        {count === 0 ? nudges.length === 0 && <div className="empty-row">You're all caught up.</div> : <Items state={state} />}
      </div>
    </>
  );
}
