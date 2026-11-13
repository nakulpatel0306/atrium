import { Inbox, SearchCheck, TriangleAlert } from "lucide-react";
import { type Ref, useState } from "react";
import { post, type State } from "../api";
import { absolute, relative } from "../format";
import { navigate } from "../route";
import { attentionText, reviewLine, summaryLine } from "../summary";
import { DecideButtons, SendBackNote, useDecision } from "./Decision";
import { OutcomeBanner } from "./OutcomeBanner";
import { askingTasks, QuestionsRow } from "./BriefQuestions";
import { needsYouCount } from "../../engine/needs";
import { ProjectDraftRow } from "./ProjectDraft";
import { ProposalRow } from "./Proposal";
import { RemovalRow } from "./RepoRemoval";
import { Markdown } from "./Markdown";
import { WhatItMade } from "./WhatItMade";

type Approval = State["approvals"][number];
type Space = State["spaces"][number];
function Row({ approval, space, state }: { approval: Approval; space: Space | undefined; state: State }) {
  const [open, setOpen] = useState(false);
  const d = useDecision(approval);
  const { error } = d;
  const review = reviewLine(approval, state);
  // What the agent said about a result that isn't plainly done; only reviews carry one.
  const task = approval.kind === "review" && approval.taskId ? state.tasks.find((t) => t.id === approval.taskId) : undefined;
  const outcome = task?.outcome && task.outcome !== "done" ? task.outcome : null;
  const attention = attentionText(task?.loop);

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
            <SearchCheck />
            {review.text}
          </span>
        )}
        <div className="acts">
          {approval.taskId && space?.kind === "repo" && approval.kind === "review" && (
            <button className="btn link" onClick={() => navigate(`/space/${space.id}?task=${approval.taskId}&view=changes`)}>
              See changes
            </button>
          )}
          <button className="btn" data-act="open" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? "Hide" : "View"}
          </button>
          <DecideButtons d={d} outcome={outcome} />
        </div>
      </div>
      {attention && (
        <div className="outcome-row">
          <p className="attention" role="note">
            <TriangleAlert />
            {attention}
          </p>
        </div>
      )}
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
      <SendBackNote d={d} />
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
      {askingTasks(state, spaceId).map((t) => (
        <QuestionsRow key={t.id} task={t} space={spaces.get(t.spaceId)} />
      ))}
      {mine(state.proposals).map((p) => (
        <ProposalRow key={p.id} proposal={p} space={spaces.get(p.spaceId)} />
      ))}
      {mine(state.approvals).map((a) => {
        const action = state.repoActions.find((r) => r.approvalId === a.id);
        if (a.alwaysAsk === "create_repo" && action?.draft) return <ProjectDraftRow key={a.id} approval={a} action={action} />;
        if (a.alwaysAsk === "remove_clone") return <RemovalRow key={a.id} approval={a} />;
        return <Row key={a.id} approval={a} space={a.spaceId ? spaces.get(a.spaceId) : undefined} state={state} />;
      })}
    </>
  );
}

export const waitingIn = (state: State, spaceId: string) =>
  state.approvals.filter((a) => a.spaceId === spaceId).length + state.proposals.filter((p) => p.spaceId === spaceId).length + askingTasks(state, spaceId).length;

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

export const needsCount = (state: State) => needsYouCount(state);

// The whole list, on Home and on the Needs you page.
export function NeedsList({ state, listRef }: { state: State; listRef?: Ref<HTMLDivElement> }) {
  return (
    <div className="list needs-list" ref={listRef}>
      {needsCount(state) === 0 ? <div className="empty-row">You're all caught up.</div> : <Items state={state} />}
    </div>
  );
}

export function NeedsYou({ state }: { state: State }) {
  const count = needsCount(state);
  return (
    <>
      <h2 id="needs">
        <Inbox />
        Needs you{count > 0 && ` · ${count}`}</h2>
      <NeedsList state={state} />
    </>
  );
}
