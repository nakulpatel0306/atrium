// The terminal app's own state (focus, selection, scroll, overlays) and every way a key can change it.
import type { AgentChoice } from "../dashboard/agents";
import { CLEARED, listOf, pick, type View } from "./select";

export type ListPane = "spaces" | "tasks" | "needs" | "activity";
export type Pane = ListPane | "detail" | "live";
export type PromptPurpose = "task" | "space" | "reply" | "goal" | "filter";

export type Overlay =
  | { kind: "help" }
  | { kind: "agents"; scroll: number }
  | { kind: "prompt"; purpose: PromptPurpose; value: string; cursor: number; agent: AgentChoice; targetId: string | null }
  | { kind: "picker"; purpose: "agent" | "reviewer"; targetId: string; options: string[]; index: number }
  | { kind: "transcript"; taskId: string; runIndex: number; scroll: number }
  | { kind: "confirm"; purpose: "archive"; targetId: string }
  // Sending a text, or accepting a result the agent said it didn't finish, waits for a y.
  | { kind: "confirm"; purpose: "send"; targetId: string }
  | { kind: "confirm"; purpose: "accept"; targetId: string };

export type Flash = { text: string; tone: "ok" | "bad" | "info" };

type Selection = { id: string | null; index: number };

export type Ui = {
  focus: Pane;
  lastLeft: ListPane;
  lastRight: "detail" | "live";
  selected: Record<ListPane, Selection>;
  filters: Record<ListPane, string>;
  detailScroll: number;
  // The made file picked in the task's detail with f, which o and R then act on.
  detailFile: number | null;
  liveScroll: number | null;
  overlay: Overlay | null;
  flash: Flash | null;
};

export type Action =
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
  | { type: "file"; index: number | null };

// Pane heights, plus how many lines Detail and Live hold so scrolling knows where the end is.
export type Rows = { detail: number; live: number; detailLines?: number; liveLines?: number };

const none: Selection = { id: null, index: 0 };

export const initialUi: Ui = {
  focus: "spaces",
  lastLeft: "spaces",
  lastRight: "detail",
  selected: { spaces: none, tasks: none, needs: none, activity: none },
  filters: { spaces: "", tasks: "", needs: "", activity: "" },
  detailScroll: 0,
  detailFile: null,
  liveScroll: null,
  overlay: null,
  flash: null,
};

const ORDER: Pane[] = ["spaces", "tasks", "needs", "activity", "detail", "live"];
const isList = (p: Pane): p is ListPane => p !== "detail" && p !== "live";

function focus(ui: Ui, pane: Pane): Ui {
  if (!isList(pane)) return { ...ui, focus: pane, lastRight: pane };
  // Detail follows the left pane last used, so a new one means new content, read from the top.
  const same = pane === ui.lastLeft;
  return { ...ui, focus: pane, lastLeft: pane, detailScroll: same ? ui.detailScroll : 0, detailFile: same ? ui.detailFile : null };
}

// Selecting another space shows different tasks and output, so their selection and scroll start over.
function select(ui: Ui, pane: ListPane, sel: Selection): Ui {
  const next = { ...ui, selected: { ...ui.selected, [pane]: sel }, detailScroll: 0, detailFile: null };
  if (pane === "spaces" && sel.id !== ui.selected.spaces.id) {
    return { ...next, selected: { ...next.selected, tasks: none }, liveScroll: null };
  }
  return next;
}

function moveTo(ui: Ui, view: View, pane: ListPane, index: (current: number, last: number) => number): Ui {
  const list = listOf(view, pane);
  if (list.length === 0) return ui;
  const { item, index: current } = pick(list, ui.selected[pane]);
  // With nothing selected, the first key picks the row in that spot rather than skipping past it.
  const to = item ? Math.min(list.length - 1, Math.max(0, index(current, list.length - 1))) : current;
  return select(ui, pane, { id: list[to]!.id, index: to });
}

const detailMax = (rows: Rows) => Math.max(0, (rows.detailLines ?? 0) - rows.detail);
const liveMax = (rows: Rows) => Math.max(0, (rows.liveLines ?? 0) - rows.live);

function scroll(ui: Ui, delta: number, rows: Rows): Ui {
  if (ui.focus === "detail") {
    return { ...ui, detailScroll: Math.min(detailMax(rows), Math.max(0, ui.detailScroll + delta)) };
  }
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

export function reduce(ui: Ui, action: Action, view: View, rows: Rows): Ui {
  switch (action.type) {
    case "focus":
      return focus(ui, action.pane);
    case "cycle": {
      const at = ORDER.indexOf(ui.focus);
      return focus(ui, ORDER[(at + action.dir + ORDER.length) % ORDER.length]!);
    }
    case "column":
      return focus(ui, action.dir === "left" ? ui.lastLeft : ui.lastRight);
    case "move":
      if (isList(ui.focus)) return moveTo(ui, view, ui.focus, (i) => i + action.delta);
      return scroll(ui, action.delta, rows);
    case "edge":
      if (isList(ui.focus)) return moveTo(ui, view, ui.focus, (_, last) => (action.to === "top" ? 0 : last));
      if (ui.focus === "detail") return { ...ui, detailScroll: action.to === "top" ? 0 : detailMax(rows) };
      return { ...ui, liveScroll: action.to === "top" ? 0 : null };
    case "page": {
      if (isList(ui.focus)) return ui;
      const half = Math.max(1, Math.floor((ui.focus === "detail" ? rows.detail : rows.live) / 2));
      return scroll(ui, half * action.dir, rows);
    }
    case "enter":
      if (ui.focus === "spaces") return focus(ui, "tasks");
      if (ui.focus === "tasks" || ui.focus === "needs") return focus(ui, "detail");
      if (ui.focus === "activity") {
        const spaceId = view.activityRow?.spaceId;
        const index = view.spaces.findIndex((s) => s.id === spaceId);
        if (index < 0) return ui;
        return focus(select(ui, "spaces", { id: spaceId!, index }), "spaces");
      }
      return ui;
    case "back":
      if (ui.focus === "detail" && ui.detailFile !== null) return { ...ui, detailFile: null };
      if (isList(ui.focus) && ui.filters[ui.focus]) return { ...ui, filters: { ...ui.filters, [ui.focus]: "" } };
      if (ui.focus === "spaces") return ui;
      return focus(ui, isList(ui.focus) ? "spaces" : ui.lastLeft);
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
      return {
        ...ui,
        filters: { ...ui.filters, [action.pane]: action.text },
        selected: { ...ui.selected, [action.pane]: none },
      };
    case "flash":
      return { ...ui, flash: action.flash };
    case "file":
      return { ...ui, detailFile: action.index };
  }
}
