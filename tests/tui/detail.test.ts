import { expect, test } from "bun:test";
import type { Message } from "../../src/engine/messages";
import type { State } from "../../src/engine/state";
import { activityDetail, approvalDetail, type DetailLine, spaceDetail, taskDetail, wrapStyled } from "../../src/tui/detail";
import { deriveView } from "../../src/tui/select";
import { initialUi, type Ui } from "../../src/tui/ui";
import { ids, makeState, task } from "./fixtures";

const text = (lines: DetailLine[]) => lines.map((l) => l.map((s) => s.text).join("")).join("\n");
const lineWith = (lines: DetailLine[], s: string) => lines.find((l) => l.map((x) => x.text).join("").includes(s));

const onTask = (id: string, index: number): Ui => ({
  ...initialUi,
  focus: "tasks",
  lastLeft: "tasks",
  selected: { ...initialUi.selected, tasks: { id, index } },
});
const msg = (fromAgent: string, toAgent: string, body: string): Message =>
  ({ id: `m_${fromAgent}`, spaceId: ids.atrium, taskId: ids.review, fromAgent, toAgent, body, createdAt: Date.now() - 60_000 }) as Message;

test("task detail has the dashboard's facts", () => {
  const view = deriveView(makeState(), onTask(ids.review, 1));
  expect(view.task?.id).toBe(ids.review);
  const lines = taskDetail(view, [msg("claude", "codex", "Please review."), msg("codex", "claude", "Fine.\nVERDICT: approve")]);
  const all = text(lines);
  for (const s of ["in review", "Branch atrium/", "Heavy · runs when plugged in", "Claude → Codex", "approves", "finished after", "t transcript"]) {
    expect(all).toContain(s);
  }
});

test("a waiting task says why in the right tone", () => {
  const state = makeState();
  const reason = state.waits[ids.queued]!.reason;
  const lines = taskDetail(deriveView(state, onTask(ids.queued, 2)), null);
  expect(lineWith(lines, reason)?.find((s) => s.text.includes(reason))?.color).toBe("yellow");

  const signedOut: State = makeState({
    waits: { [ids.queued]: { taskId: ids.queued, agent: "claude", kind: "signed_out", reason: "Claude is signed out. Run `claude` to sign in." } },
  });
  const red = taskDetail(deriveView(signedOut, onTask(ids.queued, 2)), null);
  const seg = lineWith(red, "signed out")?.find((s) => s.text.includes("signed out"));
  expect(seg?.color).toBe("red");
  expect(seg?.text).toContain("`claude`");
});

test("agent output in a task's detail is cleaned", () => {
  const state = makeState();
  state.tasks[1] = { ...state.tasks[1]!, detail: "step\x1b]0;pwned\x07 one" };
  expect(text(taskDetail(deriveView(state, onTask(ids.running, 0)), null))).toContain("step one");
});

test("approval detail shows the review line", () => {
  const review = task({ id: "tsk_rev", kind: "review", parentTaskId: ids.review, agent: "codex", status: "running", title: "Review: Fix login redirect" });
  const state = makeState();
  state.tasks.push(review);
  const ui: Ui = { ...initialUi, focus: "needs", lastLeft: "needs" };
  const lines = approvalDetail(deriveView(state, ui), null);
  const all = text(lines);
  expect(all).toContain("Codex is reviewing · you can decide now");
  expect(all).toContain("Changed 2 files.");
  expect(all).toContain("Asked ");
});

test("space detail explains a reviewer that can't work there", () => {
  const state = makeState();
  state.spaces[0] = { ...state.spaces[0]!, reviewBy: "gemini" };
  const all = text(spaceDetail(deriveView(state, initialUi), { codex: null, gemini: "Gemini never edits repos.", claude: null }));
  expect(all).toContain("Gemini never edits repos.");
  expect(all).toContain("Reviews will be skipped until you pick another reviewer.");
  expect(all).toContain("Ship the terminal app");
  expect(all).toContain("finished Fix login redirect");
});

test("activity detail shows the whole message", () => {
  const ui: Ui = { ...initialUi, focus: "activity", lastLeft: "activity" };
  const all = text(activityDetail(deriveView(makeState(), ui)));
  expect(all).toContain("Claude");
  expect(all).toContain("atrium");
  expect(all).toContain("finished Fix login redirect");
});

test("wrapStyled keeps styles across the break", () => {
  const out = wrapStyled([{ text: "ab", color: "red" }, { text: "cdef" }], 3);
  expect(out.map((l) => l.map((s) => s.text).join(""))).toEqual(["abc", "def"]);
  expect(out[0]![0]).toEqual({ text: "ab", color: "red" });
});

test("wrapStyled breaks between words when it can", () => {
  const out = wrapStyled([{ text: "can ask for one round", color: "gray" }], 12);
  expect(out.map((l) => l.map((s) => s.text).join(""))).toEqual(["can ask for", "one round"]);
  expect(out[1]![0]!.color).toBe("gray");
  expect(wrapStyled([{ text: "abcdefghij" }], 4).map((l) => l.map((s) => s.text).join(""))).toEqual(["abcd", "efgh", "ij"]);
});
