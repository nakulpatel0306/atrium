import { expect, test } from "bun:test";
import { activeOnly, type State } from "../../src/dashboard/api";

test("activeOnly drops proposals from archived spaces", () => {
  // Archived spaces aren't in state.spaces, so anything pointing at one leaves Home.
  const state = {
    spaces: [{ id: "spc_live" }],
    tasks: [],
    approvals: [{ id: "apr_1", spaceId: "spc_live" }, { id: "apr_2", spaceId: "spc_gone" }],
    proposals: [{ id: "prp_1", spaceId: "spc_live" }, { id: "prp_2", spaceId: "spc_gone" }],
  } as unknown as State;
  const active = activeOnly(state);
  expect(active.proposals.map((p) => p.id)).toEqual(["prp_1"]);
  expect(active.approvals.map((a) => a.id)).toEqual(["apr_1"]);
});
