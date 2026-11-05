import { expect, test } from "bun:test";
import { orderedTasks } from "../../src/dashboard/summary";
import { CLEARED, deriveView, pick } from "../../src/tui/select";
import { initialUi, type Ui } from "../../src/tui/ui";
import { ids, makeState } from "./fixtures";

const ui = (over: Partial<Ui> = {}): Ui => ({ ...initialUi, ...over });
const sel = (over: Partial<Ui["selected"]>) => ({ ...initialUi.selected, ...over });

test("tasks follow the selected space in dashboard order", () => {
  const state = makeState();
  const view = deriveView(state, initialUi);
  expect(view.space?.name).toBe("atrium");
  expect(view.tasks).toEqual(orderedTasks(state.tasks.filter((t) => t.spaceId === ids.atrium)));
  const other = deriveView(state, ui({ selected: sel({ spaces: { id: ids.jobHunt, index: 1 } }) }));
  expect(other.tasks.map((t) => t.id)).toEqual([ids.blocked]);
});

test("a pinned selection never slides onto another row", () => {
  const [a, b, c, fresh] = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "new" }];
  expect(pick([a, b, c], { id: "b", index: 1 })).toEqual({ item: b, index: 1 });
  // A new row above keeps the same item selected, at its new position.
  expect(pick([fresh, a, b], { id: "a", index: 0 })).toEqual({ item: a, index: 1 });
  // The pinned row went away (decided elsewhere): nothing is selected, and no neighbour takes its place.
  expect(pick([a, c], { id: "b", index: 1 })).toEqual({ item: null, index: 1 });
  expect(pick([a], { id: CLEARED, index: 0 })).toEqual({ item: null, index: 0 });
  // Not pinned yet: the row at that position, which the app pins at once.
  expect(pick([a, b], { id: null, index: 1 })).toEqual({ item: b, index: 1 });
  expect(pick([], { id: "b", index: 2 })).toEqual({ item: null, index: 0 });
});

test("filters match case-insensitively", () => {
  const state = makeState();
  const spaces = deriveView(state, ui({ filters: { ...initialUi.filters, spaces: "JOB" } }));
  expect(spaces.spaces.map((s) => s.name)).toEqual(["job hunt"]);
  expect(deriveView(state, ui({ filters: { ...initialUi.filters, needs: "LOGIN" } })).approvals).toHaveLength(1);
  expect(deriveView(state, ui({ filters: { ...initialUi.filters, needs: "Atrium" } })).approvals).toHaveLength(1);
  expect(deriveView(state, ui({ filters: { ...initialUi.filters, needs: "nope" } })).approvals).toHaveLength(0);
  const activity = deriveView(state, ui({ filters: { ...initialUi.filters, activity: "overnight" } }));
  expect(activity.activity.map((r) => r.id)).toEqual(["act_3"]);
});

test("archived spaces drop out", () => {
  const state = makeState();
  const view = deriveView({ ...state, spaces: state.spaces.filter((s) => s.id !== ids.atrium) }, initialUi);
  expect(view.space?.id).toBe(ids.jobHunt);
  expect(view.approvals).toEqual([]);
  expect(view.state.tasks.some((t) => t.spaceId === ids.atrium)).toBe(false);
});

test("live is the running run in the selected space", () => {
  const state = makeState();
  expect(deriveView(state, initialUi).live?.run.id).toBe(ids.liveRun);
  expect(deriveView(state, ui({ selected: sel({ spaces: { id: ids.jobHunt, index: 1 } }) })).live).toBeNull();
});
