// What each pane lists and which item is selected, derived fresh from the engine's state on every render.
import { activeOnly, liveRun, orderedTasks } from "../dashboard/summary";
import type { State } from "../engine/state";
import type { ListPane, Ui } from "./ui";

type Space = State["spaces"][number];
type Task = State["tasks"][number];
type Run = State["runs"][number];
type Approval = State["approvals"][number];
type ActivityRow = State["activity"][number];

export type Subject = "space" | "task" | "approval" | "activity";

export type View = {
  state: State;
  spaces: Space[];
  tasks: Task[];
  approvals: Approval[];
  activity: ActivityRow[];
  space: Space | null;
  task: Task | null;
  approval: Approval | null;
  activityRow: ActivityRow | null;
  subject: Subject;
  live: { task: Task; run: Run } | null;
};

const SUBJECT: Record<ListPane, Subject> = { spaces: "space", tasks: "task", needs: "approval", activity: "activity" };

// The engine can remove the selected row at any time (decided in the dashboard, archived), so a missing id
// falls back to whatever now sits at the same position.
export function pick<T extends { id: string }>(
  list: T[],
  sel: { id: string | null; index: number },
): { item: T | null; index: number } {
  const at = sel.id === null ? -1 : list.findIndex((x) => x.id === sel.id);
  if (at >= 0) return { item: list[at]!, index: at };
  if (list.length === 0) return { item: null, index: 0 };
  const index = Math.min(Math.max(0, sel.index), list.length - 1);
  return { item: list[index]!, index };
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
  const activity = state.activity.filter((r) => matches(ui.filters.activity, r.message));
  return {
    state,
    spaces,
    tasks,
    approvals,
    activity,
    space,
    task: pick(tasks, ui.selected.tasks).item,
    approval: pick(approvals, ui.selected.needs).item,
    activityRow: pick(activity, ui.selected.activity).item,
    subject: SUBJECT[ui.lastLeft],
    live: liveRun(state, spaceTasks),
  };
}

export function listOf(view: View, pane: ListPane): { id: string }[] {
  return pane === "spaces" ? view.spaces : pane === "tasks" ? view.tasks : pane === "needs" ? view.approvals : view.activity;
}
