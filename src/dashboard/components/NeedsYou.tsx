import { ChevronRight, Inbox, TriangleAlert } from "lucide-react";
import type { Ref } from "react";
import type { State } from "../api";
import { navigate } from "../route";
import { attentionText, summaryLine } from "../summary";
import { DecisionBar } from "./Decision";
import { OutcomeBanner } from "./OutcomeBanner";
import { QuestionsRow } from "./BriefQuestions";
import { needsYouCount } from "../../engine/needs";
import { itemLine, itemTitle, KIND_TEXT, queueOf, type QueueItem } from "../queue";
import { ProjectDraftRow } from "./ProjectDraft";
import { ProposalRow } from "./Proposal";
import { RemovalRow } from "./RepoRemoval";

type Approval = State["approvals"][number];
type Space = State["spaces"][number];
// A result or question in a list: its title and the shared decision layout, with Open going to its full screen in
// the queue (the diff, the walkthrough, the brief and the review, all in one place).
function Row({ approval, space, state }: { approval: Approval; space: Space | undefined; state: State }) {
  const task = approval.kind === "review" && approval.taskId ? state.tasks.find((t) => t.id === approval.taskId) : undefined;
  const outcome = task?.outcome && task.outcome !== "done" && !task.loop?.noChanges ? task.outcome : null;
  const attention = attentionText(task?.loop);
  return (
    <div className="entry">
      <div className="item">
        <span className="sd" style={{ background: space?.color ?? "var(--faint)" }} />
        <span className="who">{space?.name ?? (approval.spaceId === null ? "Atrium" : "Unknown space")}</span>
        <span className="t" title={approval.detail ? `${approval.title}\n${summaryLine(approval.detail)}` : approval.title}>
          {approval.title}
          {!task?.loop && approval.detail && <span>{summaryLine(approval.detail)}</span>}
        </span>
        <DecisionBar approval={approval} state={state} open={() => navigate(`/needs-you?item=${encodeURIComponent(approval.id)}`)} />
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
    </div>
  );
}

// A queue item answered on its own screen in Needs you (a pause, a CLAUDE.md line, a suggested shape): one line here,
// and Open goes to it.
function OpenRow({ item, space, state }: { item: QueueItem; space: Space | undefined; state: State }) {
  const title = itemTitle(state, item);
  const line = itemLine(state, item);
  return (
    <div className="entry">
      <div className={`item${item.low ? " low" : ""}`}>
        <span className="sd" style={{ background: space?.color ?? "var(--faint)" }} />
        <span className="who">{space?.name ?? "Atrium"}</span>
        <span className="t" title={`${title}\n${line}`}>
          {title}
          <span>{line}</span>
        </span>
        <span className="tag">{KIND_TEXT[item.kind]}</span>
        <div className="acts">
          <button className="btn" data-act="open" onClick={() => navigate(`/needs-you?item=${encodeURIComponent(item.key)}`)}>
            Open
            <ChevronRight />
          </button>
        </div>
      </div>
    </div>
  );
}

// Every item waiting on Nakul, in the queue's order (longest-blocked first), each with its own kind of answer. A
// space shows its share of the same rows.
function Items({ state, spaceId }: { state: State; spaceId?: string }) {
  const spaces = new Map(state.spaces.map((s) => [s.id, s]));
  // In a space, its CLAUDE.md proposal has a card of its own under the list.
  const items = queueOf(state).filter((i) => !spaceId || (i.spaceId === spaceId && i.kind !== "memory"));
  return (
    <>
      {items.map((i) => {
        const space = i.spaceId ? spaces.get(i.spaceId) : undefined;
        if (i.kind === "question" || i.kind === "pick" || i.kind === "stuck") return <QuestionsRow key={i.key} task={state.tasks.find((t) => t.id === i.key)!} space={space} state={state} />;
        if (i.kind === "suggestion") return <ProposalRow key={i.key} proposal={state.proposals.find((p) => p.id === i.key)!} space={space} />;
        if (i.kind === "review" || i.kind === "approval") {
          const a = state.approvals.find((x) => x.id === i.key)!;
          const action = state.repoActions.find((r) => r.approvalId === a.id);
          if (a.alwaysAsk === "create_repo" && action?.draft) return <ProjectDraftRow key={a.id} approval={a} action={action} />;
          if (a.alwaysAsk === "remove_clone") return <RemovalRow key={a.id} approval={a} />;
          return <Row key={a.id} approval={a} space={space} state={state} />;
        }
        return <OpenRow key={i.key} item={i} space={space} state={state} />;
      })}
    </>
  );
}

export const waitingIn = (state: State, spaceId: string) => queueOf(state).filter((i) => i.spaceId === spaceId && !i.low).length;

// At the top of a space: what's waiting on Nakul there, answered right where the work is.
export function SpaceNeeds({ state, spaceId }: { state: State; spaceId: string }) {
  const count = waitingIn(state, spaceId);
  if (!queueOf(state).some((i) => i.spaceId === spaceId && i.kind !== "memory")) return null;
  return (
    <>
      <h2>
        <Inbox />
        Waiting for you · {count}
      </h2>
      <div className="list needs-list space-needs">
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
      {queueOf(state).length === 0 ? <div className="empty-row">You're all caught up.</div> : <Items state={state} />}
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
