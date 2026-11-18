// The sidebar's Plum shows the engine's live state: at work while agents run, looking up when something needs you,
// and asleep when there's nothing to do.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PlumStatus } from "../../src/dashboard/components/PlumStatus";
import { plumState } from "../../src/dashboard/plum";
import { makeState, task } from "../tui/fixtures";

const empty = makeState({ tasks: [], approvals: [], proposals: [], runs: [] });

test("nothing running and nothing waiting: quiet", () => {
  expect(plumState(empty)).toEqual({ pose: "quiet", say: "All quiet" });
});

test("something waiting for you: look, with the same count as Needs you", () => {
  const s = makeState({ tasks: [], runs: [] });
  const st = plumState(s);
  expect(st.pose).toBe("look");
  expect(st.say).toMatch(/^\d+ needs? you$/);
});

test("agents running: work, even while something waits, since the badge on Needs you already counts those", () => {
  const s = makeState({ tasks: [task({ id: "t1", status: "running" }), task({ id: "t2", status: "running" })] });
  expect(plumState(s)).toEqual({ pose: "work", say: "2 at work" });
  expect(plumState(makeState({ tasks: [task({ id: "t1", status: "running" })], approvals: [], proposals: [] }))).toEqual({ pose: "work", say: "1 at work" });
});

test("one waiting reads as needs, two as need", () => {
  const one = makeState({ tasks: [] });
  const approval = one.approvals[0]!;
  expect(plumState({ ...one, approvals: [approval], proposals: [] }).say).toBe("1 needs you");
  expect(plumState({ ...one, approvals: [approval, { ...approval, id: "apr_second" }], proposals: [] }).say).toBe("2 need you");
});

test("the sidebar shows the pose's picture and says the state in words", () => {
  const html = renderToStaticMarkup(<PlumStatus state={makeState({ tasks: [task({ id: "t1", status: "running" })] })} />);
  expect(html).toContain('data-pose="work"');
  expect(html).toContain("1 at work");
  // The picture is decoration: the words carry the state.
  expect(html).toMatch(/<span class="plum-pic" aria-hidden="true"/);
});
