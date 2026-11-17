import { ChevronRight, Inbox, TriangleAlert } from "lucide-react";
import type { Ref } from "react";
import type { State } from "../api";
import { navigate } from "../route";
import { attentionText, reviewChips } from "../summary";
import { approveText } from "./Decision";
import { CostChip } from "./Shape";
import { outcomeText } from "../../engine/outcome";
import { needsYouCount } from "../../engine/needs";
import { CLEAN, goTo, KIND, RISKY } from "../../engine/words";
import { attentionQueue, isRisky, itemLine, itemTitle, type QueueItem } from "../queue";

type Space = State["spaces"][number];

// One item waiting on the user, as a summary: its title and one line saying what's going on (for a result, what the
// reviewer and the checks said), one chip (a result's Needs a look or Clean, else its kind) and its cost, and one way
// to its screen in Needs you, named for the step it asks (engine/words.ts). The reasons, the walkthrough and the diff
// are on that screen: nothing is decided from a summary.
function SummaryRow({ item, space, state }: { item: QueueItem; space: Space | undefined; state: State }) {
  const title = itemTitle(state, item);
  const approval = item.kind === "review" ? state.approvals.find((a) => a.id === item.key) : undefined;
  const task = item.taskId ? state.tasks.find((t) => t.id === item.taskId) : undefined;
  // A result the agent didn't say it finished says that first: it's what's going on.
  const told = approval && task?.outcome && task.outcome !== "done" && !task.loop?.noChanges ? outcomeText(task.outcome, task.outcomeReason) : null;
  const line = told ?? itemLine(state, item);
  const looped = approval && reviewChips(approval, state);
  const risky = !!approval && isRisky(state, approval);
  const why = [attentionText(task?.loop), line].filter(Boolean).join("\n");
  return (
    <div className="entry">
      <div className={`item summary-row${item.low ? " low" : ""}`}>
        <span className="sd" style={{ background: space?.color ?? "var(--faint)" }} />
        <span className="who">{space?.name ?? "Atrium"}</span>
        <span className="t" title={line ? `${title}\n${line}` : title}>
          {title}
          {line && <span>{line}</span>}
        </span>
        {looped ? (
          <span className="chips">
            <span className={`chip ${risky ? "waiting" : "ok"}`} title={risky ? why : line}>
              {risky && <TriangleAlert />}
              {risky ? RISKY : CLEAN}
            </span>
          </span>
        ) : (
          <span className={`tag k-${item.kind}`}>{KIND[item.kind].label}</span>
        )}
        {/* What the work cost; a low-priority item (a CLAUDE.md line, a suggestion) costs nothing itself. */}
        {task && !item.low && <CostChip spend={state.spend.tasks[task.id]} dollars />}
        <div className="acts">
          <button className="btn" data-act="open" onClick={() => navigate(`/needs-you?item=${encodeURIComponent(item.key)}`)}>
            {approval ? `${approveText(state, approval)}…` : goTo(item.kind, task?.loop?.paused?.kind === "budget")}
            <ChevronRight />
          </button>
        </div>
      </div>
    </div>
  );
}

// Every item waiting on the user, in the queue's order (longest-blocked first), with the low-priority ones as a group of
// their own under the count's items, so the number in the heading is the rows above the divider, everywhere. A space
// shows its share of the same rows.
function Items({ state, items: shown }: { state: State; items?: QueueItem[] }) {
  const spaces = new Map(state.spaces.map((s) => [s.id, s]));
  const items = shown ?? attentionQueue(state);
  const low = items.filter((i) => i.low);
  const row = (i: QueueItem) => <SummaryRow key={i.key} item={i} space={i.spaceId ? spaces.get(i.spaceId) : undefined} state={state} />;
  return (
    <>
      {items.filter((i) => !i.low).map(row)}
      {low.length > 0 && (
        <div className="low-head" role="separator">
          Low priority: nothing waits on {low.length === 1 ? "this one" : `these ${low.length}`}
        </div>
      )}
      {low.map(row)}
    </>
  );
}

export const waitingIn = (state: State, spaceId: string) => attentionQueue(state).filter((i) => i.spaceId === spaceId && !i.low).length;

// At the top of a space: what's waiting on the user there, each one leading to its screen in Needs you; the task's own
// row below decides it too, so a decision shows once as a summary and once in full.
// Kinds that are a task's own state, so its row already says them. A CLAUDE.md line or a suggestion isn't.
const ROW_KINDS = new Set<QueueItem["kind"]>(["review", "question", "pick", "stuck", "paused", "shape"]);

export function SpaceNeeds({ state, spaceId }: { state: State; spaceId: string }) {
  // A task that waits shows once, as its row in the task list with its decision inside; this list keeps the rest.
  const tasks = new Set(state.tasks.filter((t) => t.spaceId === spaceId).map((t) => t.id));
  const items = attentionQueue(state).filter((i) => i.spaceId === spaceId && !(ROW_KINDS.has(i.kind) && i.taskId && tasks.has(i.taskId)));
  if (!items.length) return null;
  const counted = items.filter((i) => !i.low).length;
  return (
    <>
      <h2>
        <Inbox />
        Also waiting for you{counted > 0 && ` · ${counted}`}
      </h2>
      <div className="list needs-list space-needs">
        <Items state={state} items={items} />
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
