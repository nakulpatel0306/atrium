// The terminal app's own state (tab, focus, selection, scroll, the Ask box, overlays) and every way a key can change it.
import type { AgentChoice } from "../dashboard/agents";
import { CLEARED, listOf, pick, type View } from "./select";

export const TABS = ["home", "spaces", "investing", "activity"] as const;
export type Tab = (typeof TABS)[number];

// Lists whose selection is pinned to a row id: spaces and tasks (Spaces), needs (Home's cards), activity.
export type ListPane = "spaces" | "tasks" | "needs" | "activity";
// Where the keys go on the Spaces tab.
export type Pane = "spaces" | "tasks" | "detail" | "live";

// What the Ask box is for right now. "ask" is the tab's own (new space, new task, symbol ask); the
// rest are the prompts other keys open in the same box.
export type AskPurpose = "ask" | "space" | "reply" | "goal" | "filter";
export type Ask = { purpose: AskPurpose; value: string; cursor: number; agent: AgentChoice; targetId: string | null };

export type Overlay =
  | { kind: "help" }
  | { kind: "agents"; scroll: number }
  | { kind: "picker"; purpose: "agent" | "reviewer"; targetId: string; options: string[]; index: number }
  | { kind: "transcript"; taskId: string; runIndex: number; scroll: number }
  // A Needs you item's full text (a question, an alert, a suggestion), scrollable.
  | { kind: "detail"; scroll: number }
  | { kind: "confirm"; purpose: "archive"; targetId: string }
  // Deleting a space for good waits for its name, typed in full.
  | { kind: "delete"; spaceId: string; value: string; cursor: number }
  | { kind: "confirm"; purpose: "accept"; targetId: string }
  | { kind: "confirm"; purpose: "stop"; targetId: string };

export type Flash = { text: string; tone: "ok" | "bad" | "info" };

type Selection = { id: string | null; index: number };

export type Ui = {
  tab: Tab;
  focus: Pane;
  lastLeft: "spaces" | "tasks";
  lastRight: "detail" | "live";
  selected: Record<ListPane, Selection>;
  filters: Record<ListPane, string>;
  detailScroll: number;
  // The made file picked in the task's detail with f, which o and R then act on.
  detailFile: number | null;
  liveScroll: number | null;
  // Investing: the symbol row.
  invest: { row: number };
  activityScroll: number;
  // Null while the cursor isn't in the Ask box.
  ask: Ask | null;
  overlay: Overlay | null;
  flash: Flash | null;
};

export type Action =
  | { type: "tab"; tab: Tab }
  | { type: "focus"; pane: Pane }
  | { type: "cycle"; dir: 1 | -1 }
  | { type: "column"; dir: "left" | "right" }
  | { type: "move"; delta: number }
  | { type: "edge"; to: "top" | "bottom" }
  | { type: "page"; dir: 1 | -1 }
  | { type: "enter" }
  | { type: "back" }
  | { type: "open"; overlay: Overlay }
  | { type: "close" }
  | { type: "setOverlay"; overlay: Overlay }
  | { type: "select"; pane: ListPane; id: string }
  | { type: "unpin"; pane: ListPane }
  | { type: "filter"; pane: ListPane; text: string }
  | { type: "flash"; flash: Flash | null }
  | { type: "file"; index: number | null }
  | { type: "ask"; ask: Ask | null }
  | { type: "row"; index: number };

// How many lines each scrollable part holds and shows, so scrolling and moving know where the ends are.
export type Rows = { detail: number; live: number; detailLines?: number; liveLines?: number; investRows?: number; activityLines?: number; activity?: number };

const none: Selection = { id: null, index: 0 };

export const initialUi: Ui = {
  tab: "home",
  focus: "spaces",
  lastLeft: "spaces",
  lastRight: "detail",
  selected: { spaces: none, tasks: none, needs: none, activity: none },
  filters: { spaces: "", tasks: "", needs: "", activity: "" },
  detailScroll: 0,
  detailFile: null,
  liveScroll: null,
  invest: { row: 0 },
  activityScroll: 0,
  ask: null,
  overlay: null,
  flash: null,
};

const ORDER: Pane[] = ["spaces", "tasks", "detail", "live"];
const isList = (p: Pane): p is "spaces" | "tasks" => p === "spaces" || p === "tasks";

// The list the arrow keys move through on this tab, if any.
export function listPaneOf(ui: Ui): ListPane | null {
  if (ui.tab === "home") return "needs";
  if (ui.tab === "activity") return "activity";
  if (ui.tab === "spaces" && isList(ui.focus)) return ui.focus;
  return null;
}

function focus(ui: Ui, pane: Pane): Ui {
  if (!isList(pane)) return { ...ui, focus: pane, lastRight: pane };
  // Detail follows the left pane last used, so a new one means new content, read from the top.
  const same = pane === ui.lastLeft;
  return { ...ui, focus: pane, lastLeft: pane, detailScroll: same ? ui.detailScroll : 0, detailFile: same ? ui.detailFile : null };
}

// Selecting another space shows different tasks and output, so their selection and scroll start over.
function select(ui: Ui, pane: ListPane, sel: Selection): Ui {
  const next = { ...ui, selected: { ...ui.selected, [pane]: sel } };
  if (pane === "activity") return { ...next, activityScroll: 0 };
  if (pane === "needs") return next;
  const reset = { ...next, detailScroll: 0, detailFile: null };
  if (pane === "spaces" && sel.id !== ui.selected.spaces.id) return { ...reset, selected: { ...reset.selected, tasks: none }, liveScroll: null };
  return reset;
}

function moveTo(ui: Ui, view: View, pane: ListPane, index: (current: number, last: number) => number): Ui {
  const list = listOf(view, pane);
  if (list.length === 0) return ui;
  const { item, index: current } = pick(list, ui.selected[pane]);
  // With nothing selected, the first key picks the row in that spot rather than skipping past it.
  const to = item ? Math.min(list.length - 1, Math.max(0, index(current, list.length - 1))) : current;
  return select(ui, pane, { id: list[to]!.id, index: to });
}

const clamp = (n: number, max: number) => Math.min(Math.max(0, max), Math.max(0, n));
const detailMax = (rows: Rows) => Math.max(0, (rows.detailLines ?? 0) - rows.detail);
const liveMax = (rows: Rows) => Math.max(0, (rows.liveLines ?? 0) - rows.live);
const activityMax = (rows: Rows) => Math.max(0, (rows.activityLines ?? 0) - (rows.activity ?? 0));

function scroll(ui: Ui, delta: number, rows: Rows): Ui {
  if (ui.focus === "detail") return { ...ui, detailScroll: clamp(ui.detailScroll + delta, detailMax(rows)) };
  // Scrolling back down to the end resumes following, like a pager.
  const top = (ui.liveScroll ?? liveMax(rows)) + delta;
  return { ...ui, liveScroll: top >= liveMax(rows) ? null : Math.max(0, top) };
}

const LIST_PANES: ListPane[] = ["spaces", "tasks", "needs", "activity"];

// Turns each unpinned selection into a pin on the row it shows. Run on every state and UI change, so a row
// arriving later can't take its place. Returns `ui` itself when nothing changed.
export function pin(ui: Ui, view: View): Ui {
  let next = ui;
  for (const pane of LIST_PANES) {
    if (ui.selected[pane].id !== null) continue;
    const { item, index } = pick(listOf(view, pane), ui.selected[pane]);
    if (item) next = { ...next, selected: { ...next.selected, [pane]: { id: item.id, index } } };
  }
  return next;
}

function moveRow(ui: Ui, to: number, count: number): Ui {
  return { ...ui, invest: { row: clamp(to, count - 1) } };
}

export function reduce(ui: Ui, action: Action, view: View, rows: Rows): Ui {
  switch (action.type) {
    case "tab":
      return { ...ui, tab: action.tab };
    case "focus":
      return focus({ ...ui, tab: "spaces" }, action.pane);
    case "cycle": {
      const at = ORDER.indexOf(ui.focus);
      return focus(ui, ORDER[(at + action.dir + ORDER.length) % ORDER.length]!);
    }
    case "column":
      return focus(ui, action.dir === "left" ? ui.lastLeft : ui.lastRight);
    case "move": {
      const pane = listPaneOf(ui);
      if (pane) return moveTo(ui, view, pane, (i) => i + action.delta);
      if (ui.tab === "investing") return moveRow(ui, ui.invest.row + action.delta, rows.investRows ?? 0);
      if (ui.tab === "spaces") return scroll(ui, action.delta, rows);
      return ui;
    }
    case "edge": {
      const pane = listPaneOf(ui);
      if (pane) return moveTo(ui, view, pane, (_, last) => (action.to === "top" ? 0 : last));
      if (ui.tab === "investing") return moveRow(ui, action.to === "top" ? 0 : Number.MAX_SAFE_INTEGER, rows.investRows ?? 0);
      if (ui.tab !== "spaces") return ui;
      if (ui.focus === "detail") return { ...ui, detailScroll: action.to === "top" ? 0 : detailMax(rows) };
      return { ...ui, liveScroll: action.to === "top" ? 0 : null };
    }
    case "page": {
      if (ui.tab === "activity") {
        const half = Math.max(1, Math.floor((rows.activity ?? 10) / 2));
        return { ...ui, activityScroll: clamp(ui.activityScroll + half * action.dir, activityMax(rows)) };
      }
      if (ui.tab !== "spaces" || isList(ui.focus)) return ui;
      const half = Math.max(1, Math.floor((ui.focus === "detail" ? rows.detail : rows.live) / 2));
      return scroll(ui, half * action.dir, rows);
    }
    case "enter":
      if (ui.tab === "spaces" && ui.focus === "spaces") return focus(ui, "tasks");
      if (ui.tab === "spaces" && ui.focus === "tasks") return focus(ui, "detail");
      if (ui.tab === "activity") {
        const spaceId = view.activityRow?.spaceId;
        const index = view.spaces.findIndex((s) => s.id === spaceId);
        if (index < 0) return ui;
        return focus({ ...select(ui, "spaces", { id: spaceId!, index }), tab: "spaces" }, "spaces");
      }
      return ui;
    case "back": {
      const pane = listPaneOf(ui);
      if (ui.tab === "spaces" && ui.focus === "detail" && ui.detailFile !== null) return { ...ui, detailFile: null };
      if (pane && ui.filters[pane]) return { ...ui, filters: { ...ui.filters, [pane]: "" } };
      if (ui.tab !== "spaces" || ui.focus === "spaces") return ui;
      return focus(ui, isList(ui.focus) ? "spaces" : ui.lastLeft);
    }
    case "open":
    case "setOverlay":
      return { ...ui, overlay: action.overlay };
    case "close":
      return { ...ui, overlay: null };
    case "select": {
      // A space just set up may not be in the state yet; its id is kept and found once it arrives.
      const index = listOf(view, action.pane).findIndex((x) => x.id === action.id);
      return select(ui, action.pane, { id: action.id, index: Math.max(0, index) });
    }
    case "unpin":
      return { ...ui, selected: { ...ui.selected, [action.pane]: { id: CLEARED, index: ui.selected[action.pane].index } } };
    case "filter":
      return { ...ui, filters: { ...ui.filters, [action.pane]: action.text }, selected: { ...ui.selected, [action.pane]: none } };
    case "flash":
      return { ...ui, flash: action.flash };
    case "file":
      return { ...ui, detailFile: action.index };
    case "ask":
      return { ...ui, ask: action.ask };
    case "row":
      return { ...ui, invest: { row: action.index } };
  }
}
