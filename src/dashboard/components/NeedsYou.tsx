import { ChevronRight, Inbox, TriangleAlert } from "lucide-react";
import type { Ref } from "react";
import type { State } from "../api";
import { navigate } from "../route";
import { attentionText, reviewChips } from "../summary";
import { approveText, Chips } from "./Decision";
import { OutcomeBanner } from "./OutcomeBanner";
import { needsYouCount } from "../../engine/needs";
import { goTo, KIND } from "../../engine/words";
import { attentionQueue, itemLine, itemTitle, type QueueItem } from "../queue";

type Space = State["spaces"][number];

// One item waiting on Nakul, as a summary: what kind it is, its title, one line (for a result, what the checks and the
// reviewer said, as two chips), and one way to its screen in Needs you, named for the step it asks (engine/words.ts).
// Deciding happens there, with the walkthrough and the diff in view, never from a summary.
function SummaryRow({ item, space, state }: { item: QueueItem; space: Space | undefined; state: State }) {
  const title = itemTitle(state, item);
  const approval = item.kind === "review" ? state.approvals.find((a) => a.id === item.key) : undefined;
  const task = item.taskId ? state.tasks.find((t) => t.id === item.taskId) : undefined;
  const chips = approval ? reviewChips(approval, state) : null;
  const line = chips ? null : itemLine(state, item);
  const outcome = approval && task?.outcome && task.outcome !== "done" && !task.loop?.noChanges ? task.outcome : null;
  const attention = approval ? attentionText(task?.loop) : null;
  return (
    <div className="entry">
      <div className={`item summary-row${item.low ? " low" : ""}`}>
        <span className="sd" style={{ background: space?.color ?? "var(--faint)" }} />
        <span className="who">{space?.name ?? "Atrium"}</span>
        <span className="t" title={line ? `${title}\n${line}` : title}>
          {title}
          {line && <span>{line}</span>}
        </span>
        {chips && <Chips chips={chips} />}
        <span className={`tag k-${item.kind}`}>{KIND[item.kind].label}</span>
        <div className="acts">
          <button className="btn" data-act="open" onClick={() => navigate(`/needs-you?item=${encodeURIComponent(item.key)}`)}>
            {approval ? `${approveText(state, approval)}…` : goTo(item.kind)}
            <ChevronRight />
          </button>
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
    </div>
  );
}

// Every item waiting on Nakul, in the queue's order (longest-blocked first). A space shows its share of the same rows.
function Items({ state, spaceId }: { state: State; spaceId?: string }) {
  const spaces = new Map(state.spaces.map((s) => [s.id, s]));
  // In a space, its CLAUDE.md proposal has a card of its own under the list.
  const items = attentionQueue(state).filter((i) => !spaceId || (i.spaceId === spaceId && i.kind !== "memory"));
  return (
    <>
      {items.map((i) => (
        <SummaryRow key={i.key} item={i} space={i.spaceId ? spaces.get(i.spaceId) : undefined} state={state} />
      ))}
    </>
  );
}

export const waitingIn = (state: State, spaceId: string) => attentionQueue(state).filter((i) => i.spaceId === spaceId && !i.low).length;

// At the top of a space: what's waiting on Nakul there, each one leading to its screen in Needs you; the task's own
// row below decides it too, so a decision shows once as a summary and once in full.
export function SpaceNeeds({ state, spaceId }: { state: State; spaceId: string }) {
  const count = waitingIn(state, spaceId);
  if (!attentionQueue(state).some((i) => i.spaceId === spaceId && i.kind !== "memory")) return null;
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
      {attentionQueue(state).length === 0 ? <div className="empty-row">You're all caught up.</div> : <Items state={state} />}
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
