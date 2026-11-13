import { expect, test } from "bun:test";
import { CLEARED, deriveView } from "../../src/tui/select";
import { type Action, initialUi, pin, reduce, type Ui } from "../../src/tui/ui";
import { ids, makeState } from "./fixtures";

const state = makeState();
const rows = { detail: 20, live: 10, detailLines: 100, liveLines: 50, investRows: 3, activity: 10, activityLines: 30 };
const onSpaces: Ui = { ...initialUi, tab: "spaces" };
const run = (actions: Action[], start: Ui = onSpaces) => actions.reduce((ui, a) => reduce(ui, a, deriveView(state, ui), rows), start);

test("Home opens first, and tabs switch", () => {
  expect(initialUi.tab).toBe("home");
  expect(run([{ type: "tab", tab: "activity" }]).tab).toBe("activity");
});

test("move and edges stay in range", () => {
  const moved = run([{ type: "move", delta: 5 }]);
  expect(moved.selected.spaces).toEqual({ id: ids.jobHunt, index: 1 });
  expect(run([{ type: "edge", to: "top" }], moved).selected.spaces).toEqual({ id: ids.atrium, index: 0 });
});

test("on Home and Activity the arrows move through their own list", () => {
  const home = run([{ type: "move", delta: 1 }], initialUi);
  expect(home.selected.needs).toEqual({ id: ids.approval, index: 0 });
  const act = run([{ type: "tab", tab: "activity" }, { type: "move", delta: 1 }], initialUi);
  expect(act.selected.activity.index).toBe(1);
  expect(act.selected.spaces.id).toBeNull();
});

test("changing space resets the task selection and scrolls", () => {
  const start: Ui = { ...onSpaces, selected: { ...initialUi.selected, tasks: { id: ids.queued, index: 3 } }, detailScroll: 7, liveScroll: 4 };
  const ui = run([{ type: "move", delta: 1 }], start);
  expect(ui.selected.tasks).toEqual({ id: null, index: 0 });
  expect(ui.detailScroll).toBe(0);
  expect(ui.liveScroll).toBeNull();
});

test("enter drills in, and on Activity opens the space", () => {
  expect(run([{ type: "enter" }]).focus).toBe("tasks");
  expect(run([{ type: "focus", pane: "tasks" }, { type: "enter" }]).focus).toBe("detail");
  const fromActivity = run([{ type: "tab", tab: "activity" }, { type: "move", delta: 1 }, { type: "enter" }], initialUi);
  expect(fromActivity.tab).toBe("spaces");
  expect(fromActivity.focus).toBe("spaces");
  expect(fromActivity.selected.spaces).toEqual({ id: ids.jobHunt, index: 1 });
});

test("column and cycle remember the last pane", () => {
  const tasks = run([{ type: "focus", pane: "tasks" }, { type: "column", dir: "right" }]);
  expect(tasks.focus).toBe("detail");
  expect(run([{ type: "focus", pane: "live" }, { type: "column", dir: "left" }], tasks).focus).toBe("tasks");
  expect(run([{ type: "focus", pane: "tasks" }, { type: "cycle", dir: 1 }]).focus).toBe("detail");
  expect(run([{ type: "focus", pane: "live" }, { type: "cycle", dir: 1 }]).focus).toBe("spaces");
  expect(run([{ type: "cycle", dir: -1 }]).focus).toBe("live");
});

test("focusing a pane from another tab goes to Spaces", () => {
  expect(run([{ type: "focus", pane: "detail" }], initialUi).tab).toBe("spaces");
});

test("j/k scroll detail and live, G follows", () => {
  const live = run([{ type: "focus", pane: "live" }, { type: "move", delta: -3 }]);
  expect(live.liveScroll).toBe(37);
  expect(run([{ type: "edge", to: "bottom" }], live).liveScroll).toBeNull();
  expect(run([{ type: "move", delta: 3 }], live).liveScroll).toBeNull();
  const detail = run([{ type: "focus", pane: "detail" }, { type: "page", dir: 1 }]);
  expect(detail.detailScroll).toBe(10);
  expect(run([{ type: "move", delta: -50 }], detail).detailScroll).toBe(0);
});

test("ctrl-d scrolls the picked activity's lines", () => {
  const ui = run([{ type: "tab", tab: "activity" }, { type: "page", dir: 1 }, { type: "page", dir: 1 }, { type: "page", dir: 1 }, { type: "page", dir: 1 }, { type: "page", dir: 1 }]);
  expect(ui.activityScroll).toBe(20);
});

test("back clears the filter first", () => {
  const start: Ui = { ...onSpaces, focus: "tasks", lastLeft: "tasks", filters: { ...initialUi.filters, tasks: "x" } };
  const once = run([{ type: "back" }], start);
  expect(once.filters.tasks).toBe("");
  expect(once.focus).toBe("tasks");
  expect(run([{ type: "back" }], once).focus).toBe("spaces");
  const home: Ui = { ...initialUi, filters: { ...initialUi.filters, needs: "atrium" } };
  expect(run([{ type: "back" }], home).filters.needs).toBe("");
});

test("the tab and the left pane set the subject", () => {
  expect(deriveView(state, initialUi).subject).toBe("approval");
  expect(deriveView(state, run([{ type: "focus", pane: "tasks" }, { type: "focus", pane: "detail" }])).subject).toBe("task");
  expect(deriveView(state, onSpaces).subject).toBe("space");
  expect(deriveView(state, { ...initialUi, tab: "activity" }).subject).toBe("activity");
});

test("overlays, the Ask box and flashes", () => {
  const open = run([{ type: "open", overlay: { kind: "help" } }]);
  expect(open.overlay).toEqual({ kind: "help" });
  expect(run([{ type: "close" }], open).overlay).toBeNull();
  expect(run([{ type: "flash", flash: { text: "hi", tone: "ok" } }]).flash?.text).toBe("hi");
  const ask = { purpose: "ask" as const, value: "hi", cursor: 2, agent: "auto" as const, targetId: null };
  expect(run([{ type: "ask", ask }]).ask).toEqual(ask);
  expect(run([{ type: "ask", ask: null }]).ask).toBeNull();
});

test("select picks a row by id, even before the engine lists it", () => {
  const ui = run([{ type: "select", pane: "spaces", id: ids.jobHunt }]);
  expect(ui.selected.spaces).toEqual({ id: ids.jobHunt, index: 1 });
  expect(run([{ type: "select", pane: "spaces", id: "spc_new" }]).selected.spaces).toEqual({ id: "spc_new", index: 0 });
});

test("Detail starts at the top when the left pane it follows changes", () => {
  const scrolled: Ui = { ...onSpaces, focus: "detail", lastLeft: "tasks", detailScroll: 12 };
  expect(run([{ type: "focus", pane: "spaces" }], scrolled).detailScroll).toBe(0);
  expect(run([{ type: "focus", pane: "tasks" }], scrolled).detailScroll).toBe(12);
  expect(run([{ type: "focus", pane: "live" }], scrolled).detailScroll).toBe(12);
});

test("pin fixes each list's selection to the row it shows", () => {
  const pinned = pin(initialUi, deriveView(state, initialUi));
  expect(pinned.selected.spaces).toEqual({ id: ids.atrium, index: 0 });
  expect(pinned.selected.needs).toEqual({ id: ids.approval, index: 0 });
  expect(pin(pinned, deriveView(state, pinned))).toBe(pinned);
  const cleared: Ui = { ...pinned, selected: { ...pinned.selected, needs: { id: CLEARED, index: 0 } } };
  expect(pin(cleared, deriveView(state, cleared)).selected.needs.id).toBe(CLEARED);
});

test("unpin leaves nothing selected, and j picks the row in that spot without moving past it", () => {
  const start: Ui = { ...onSpaces, selected: { ...initialUi.selected, spaces: { id: ids.atrium, index: 0 } } };
  const unpinned = run([{ type: "unpin", pane: "spaces" }], start);
  expect(unpinned.selected.spaces).toEqual({ id: CLEARED, index: 0 });
  expect(run([{ type: "move", delta: 1 }], unpinned).selected.spaces).toEqual({ id: ids.atrium, index: 0 });
});

test("a new filter starts the selection over", () => {
  const start: Ui = { ...onSpaces, selected: { ...initialUi.selected, spaces: { id: ids.jobHunt, index: 1 } } };
  expect(run([{ type: "filter", pane: "spaces", text: "a" }], start).selected.spaces).toEqual({ id: null, index: 0 });
});
