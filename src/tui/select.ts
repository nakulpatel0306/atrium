// What each pane lists and which item is selected, derived fresh from the engine's state on every render.
import { activeOnly, liveRun, orderedTasks } from "../dashboard/summary";
import type { State } from "../engine/state";
import type { ListPane, Ui } from "./ui";

type Space = State["spaces"][number];
type Task = State["tasks"][number];
type Run = State["runs"][number];
type Approval = State["approvals"][number];
type Proposal = State["proposals"][number];
type ActivityRow = State["activity"][number];

export type Subject = "space" | "task" | "approval" | "activity";

export type View = {
  state: State;
  spaces: Space[];
  tasks: Task[];
  approvals: Approval[];
  // "Stop asking about …?" suggestions; they share Needs you with approvals and list first.
  proposals: Proposal[];
  activity: ActivityRow[];
  space: Space | null;
  task: Task | null;
  approval: Approval | null;
  proposal: Proposal | null;
  activityRow: ActivityRow | null;
  subject: Subject;
  live: { task: Task; run: Run } | null;
};

const SUBJECT: Record<ListPane, Subject> = { spaces: "space", tasks: "task", needs: "approval", activity: "activity" };

// A selection id that pins nothing: after a decision, or once the pinned row has gone.
export const CLEARED = "";

// Selections are pinned to a row id, so rows arriving or leaving never put a different item under the cursor
// (pressing `a` must approve what Nakul was looking at). Only an unpinned selection (id null, before the app
// pins it) resolves by position; a pinned row that has gone leaves nothing selected.
export function pick<T extends { id: string }>(
  list: T[],
  sel: { id: string | null; index: number },
): { item: T | null; index: number } {
  if (list.length === 0) return { item: null, index: 0 };
  const index = Math.min(Math.max(0, sel.index), list.length - 1);
  if (sel.id === null) return { item: list[index]!, index };
  const at = list.findIndex((x) => x.id === sel.id);
  return at >= 0 ? { item: list[at]!, index: at } : { item: null, index };
}

const matches = (filter: string, ...fields: (string | null | undefined)[]) => {
  const f = filter.trim().toLowerCase();
  return !f || fields.some((x) => x?.toLowerCase().includes(f));
};

export function deriveView(raw: State, ui: Ui): View {
  const state = activeOnly(raw);
  const names = new Map(state.spaces.map((s) => [s.id, s.name]));
  const spaces = state.spaces.filter((s) => matches(ui.filters.spaces, s.name));
  const space = pick(spaces, ui.selected.spaces).item;
  const spaceTasks = space ? state.tasks.filter((t) => t.spaceId === space.id) : [];
  const tasks = orderedTasks(spaceTasks).filter((t) => matches(ui.filters.tasks, t.title));
  const approvals = state.approvals.filter((a) => matches(ui.filters.needs, a.title, names.get(a.spaceId)));
  const proposals = state.proposals.filter((p) => matches(ui.filters.needs, p.label, names.get(p.spaceId)));
  const needs = pick<Approval | Proposal>([...proposals, ...approvals], ui.selected.needs).item;
  const activity = state.activity.filter((r) => matches(ui.filters.activity, r.message));
  return {
    state,
    spaces,
    tasks,
    approvals,
    proposals,
    activity,
    space,
    task: pick(tasks, ui.selected.tasks).item,
    approval: needs && "title" in needs ? needs : null,
    proposal: needs && "label" in needs ? needs : null,
    activityRow: pick(activity, ui.selected.activity).item,
    subject: SUBJECT[ui.lastLeft],
    live: liveRun(state, spaceTasks),
  };
}

export function listOf(view: View, pane: ListPane): { id: string }[] {
  if (pane === "needs") return [...view.proposals, ...view.approvals];
  return pane === "spaces" ? view.spaces : pane === "tasks" ? view.tasks : view.activity;
}
