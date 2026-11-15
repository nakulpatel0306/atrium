// What each pane lists and which item is selected, derived fresh from the engine's state on every render.
import { activeOnly, liveRun, orderedTasks } from "../dashboard/summary";
import { type ActivityGroup, groupActivity } from "../engine/activity-groups";
import { attentionQueue, type QueueItem } from "../engine/needs";
import { itemLine, itemTitle } from "../dashboard/queue";
import type { State } from "../engine/state";
import type { ListPane, Ui } from "./ui";

type Space = State["spaces"][number];
type Task = State["tasks"][number];
type Run = State["runs"][number];
type Approval = State["approvals"][number];
type Proposal = State["proposals"][number];

type Subject = "space" | "task" | "approval" | "activity";

export type View = {
  state: State;
  spaces: Space[];
  tasks: Task[];
  approvals: Approval[];
  // "Stop asking about …?" suggestions; they share Needs you with approvals.
  proposals: Proposal[];
  // Tasks asking before they start.
  asking: Task[];
  // Everything in Needs you, in the one queue's order (engine/needs.ts): longest-blocked first, low-priority last.
  queue: QueueItem[];
  // The selected queue item, whatever its kind; the fields below narrow it for the keys.
  item: QueueItem | null;
  // The feed folded into groups (see activity-groups.ts); the detail shows a group's full lines.
  activity: ActivityGroup[];
  space: Space | null;
  task: Task | null;
  approval: Approval | null;
  proposal: Proposal | null;
  askingTask: Task | null;
  activityRow: ActivityGroup | null;
  subject: Subject;
  live: { task: Task; run: Run } | null;
};

function subjectOf(ui: Ui): Subject {
  if (ui.tab === "home") return "approval";
  if (ui.tab === "activity") return "activity";
  return ui.lastLeft === "tasks" ? "task" : "space";
}

// A selection id that pins nothing: after a decision, or once the pinned row has gone.
export const CLEARED = "";

// Selections are pinned to a row id, so rows arriving or leaving never put a different item under the cursor
// (pressing `a` must approve what the user was looking at). Only an unpinned selection (id null, before the app
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
  // Archived spaces list after the active ones, so they can be restored or deleted from here.
  const spaces = [...state.spaces, ...(raw.archived ?? [])].filter((s) => matches(ui.filters.spaces, s.name));
  const space = pick(spaces, ui.selected.spaces).item;
  const spaceTasks = space ? state.tasks.filter((t) => t.spaceId === space.id) : [];
  const tasks = orderedTasks(spaceTasks).filter((t) => matches(ui.filters.tasks, t.title));
  const approvals = state.approvals.filter((a) => matches(ui.filters.needs, a.title, a.spaceId ? names.get(a.spaceId) : "Atrium"));
  const proposals = state.proposals.filter((p) => matches(ui.filters.needs, p.label, names.get(p.spaceId)));
  // The terminal app has no Undo, so a held yes (only Undo can act on it) stays in the dashboard's list.
  const queue = attentionQueue(state).filter((i) => i.kind !== "starting" && matches(ui.filters.needs, itemTitle(state, i), itemLine(state, i), i.spaceId ? names.get(i.spaceId) : "Atrium"));
  const item = pick(queue.map((i) => ({ ...i, id: i.key })), ui.selected.needs).item;
  const asking = queue.filter((i) => i.kind === "question" || i.kind === "pick" || i.kind === "stuck").map((i) => state.tasks.find((t) => t.id === i.key)!);
  const activity = groupActivity(state.activity, { tasks: state.tasks, files: state.activityFiles }).filter((g) =>
    matches(ui.filters.activity, g.text, g.title, ...g.events.map((e) => e.message)),
  );
  return {
    state,
    spaces,
    tasks,
    approvals,
    proposals,
    asking,
    queue,
    item,
    activity,
    space,
    task: pick(tasks, ui.selected.tasks).item,
    approval: item && (item.kind === "review" || item.kind === "approval") ? (state.approvals.find((a) => a.id === item.key) ?? null) : null,
    proposal: item?.kind === "suggestion" ? (state.proposals.find((p) => p.id === item.key) ?? null) : null,
    askingTask: item && (item.kind === "question" || item.kind === "pick" || item.kind === "stuck") ? (state.tasks.find((t) => t.id === item.key) ?? null) : null,
    activityRow: pick(activity, ui.selected.activity).item,
    subject: subjectOf(ui),
    live: liveRun(state, spaceTasks),
  };
}

export function listOf(view: View, pane: ListPane): { id: string }[] {
  if (pane === "needs") return view.queue.map((i) => ({ id: i.key }));
  return pane === "spaces" ? view.spaces : pane === "tasks" ? view.tasks : view.activity;
}
