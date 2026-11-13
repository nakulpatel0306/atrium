import { expect, test } from "bun:test";
import { parseRoute } from "../../src/dashboard/route";

test("/rules is the Rules page", () => {
  expect(parseRoute("/rules")).toEqual({ name: "rules" });
  expect(parseRoute("/rules?x=1")).toEqual({ name: "rules" });
});

test("existing routes still parse", () => {
  expect(parseRoute("/")).toEqual({ name: "home" });
  expect(parseRoute("/agents")).toEqual({ name: "agents" });
  expect(parseRoute("/space/spc_1?task=tsk_2")).toEqual({ name: "space", id: "spc_1", task: "tsk_2", tab: "tasks", changes: false });
});

test("a space's tab comes from ?tab=", () => {
  expect(parseRoute("/space/s?task=t&tab=files")).toEqual({ name: "space", id: "s", task: "t", tab: "files", changes: false });
  expect(parseRoute("/space/s?tab=files")).toEqual({ name: "space", id: "s", task: null, tab: "files", changes: false });
  expect(parseRoute("/space/s?tab=nonsense")).toEqual({ name: "space", id: "s", task: null, tab: "tasks", changes: false });
});

test("&view=changes opens a task on its Changes", () => {
  expect(parseRoute("/space/s?task=t&view=changes")).toEqual({ name: "space", id: "s", task: "t", tab: "tasks", changes: true });
});
