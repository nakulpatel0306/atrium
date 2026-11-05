import { expect, test } from "bun:test";
import { parseRoute } from "../../src/dashboard/route";

test("/rules is the Rules page", () => {
  expect(parseRoute("/rules")).toEqual({ name: "rules" });
  expect(parseRoute("/rules?x=1")).toEqual({ name: "rules" });
});

test("existing routes still parse", () => {
  expect(parseRoute("/")).toEqual({ name: "home" });
  expect(parseRoute("/agents")).toEqual({ name: "agents" });
  expect(parseRoute("/space/spc_1?task=tsk_2")).toEqual({ name: "space", id: "spc_1", task: "tsk_2" });
});
