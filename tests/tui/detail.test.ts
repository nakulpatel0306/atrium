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
  expect(lineWith(lines, reason)?.find((s) => s.text.includes(reason))?.color).toBe("warn");

  const signedOut: State = makeState({
    waits: { [ids.queued]: { taskId: ids.queued, agent: "claude", kind: "signed_out", reason: "Claude is signed out. Run `claude` to sign in." } },
  });
  const red = taskDetail(deriveView(signedOut, onTask(ids.queued, 2)), null);
  const seg = lineWith(red, "signed out")?.find((s) => s.text.includes("signed out"));
  expect(seg?.color).toBe("bad");
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
  const ui: Ui = { ...initialUi };
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
  const ui: Ui = { ...initialUi, tab: "activity" };
  const all = text(activityDetail(deriveView(makeState(), ui)));
  expect(all).toContain("Claude");
  expect(all).toContain("atrium");
  expect(all).toContain("finished Fix login redirect");
});

test("wrapStyled keeps styles across the break", () => {
  const out = wrapStyled([{ text: "ab", color: "bad" }, { text: "cdef" }], 3);
  expect(out.map((l) => l.map((s) => s.text).join(""))).toEqual(["abc", "def"]);
  expect(out[0]![0]).toEqual({ text: "ab", color: "bad" });
});

test("wrapStyled breaks between words when it can", () => {
  const out = wrapStyled([{ text: "can ask for one round", color: "dim" }], 12);
  expect(out.map((l) => l.map((s) => s.text).join(""))).toEqual(["can ask for", "one round"]);
  expect(out[1]![0]!.color).toBe("dim");
  expect(wrapStyled([{ text: "abcdefghij" }], 4).map((l) => l.map((s) => s.text).join(""))).toEqual(["abcd", "efgh", "ij"]);
});

test("a repo question's detail says it belongs to Atrium and where to edit it", () => {
  const state = makeState();
  state.approvals = [{ ...state.approvals[0]!, spaceId: null, taskId: null, kind: "question", alwaysAsk: "create_repo", title: 'Create GitHub repo "demo"?', detail: "Name: demo" }];
  const ui: Ui = { ...initialUi };
  const all = text(approvalDetail(deriveView(state, ui), null));
  expect(all).toContain("Atrium");
  expect(all).not.toContain("Unknown space");
  expect(all).toContain("Name: demo");
  expect(all).toContain("Edit the fields in the dashboard. a approves them as shown.");
});

test("needs can be filtered by Atrium", () => {
  const state = makeState();
  state.approvals.push({ ...state.approvals[0]!, id: "apr_repo", spaceId: null, taskId: null, kind: "question", title: "Remove the local copy of o/n?" });
  const view = deriveView(state, { ...initialUi, filters: { ...initialUi.filters, needs: "atrium" } });
  expect(view.approvals.map((a) => a.id)).toContain("apr_repo");
});

const outputs = {
  summary: { text: "**Done.** Made your list.", status: "pending" as const, decidedBy: "you" as const, at: Date.now() },
  files: [
    { id: "rf1", runId: "r", root: "space" as const, ref: null, path: "grocery-list.md", absPath: "/a/grocery-list.md", change: "created" as const, size: 2662, insertions: null, deletions: null, kind: "markdown" as const, exists: true, at: 1 },
    { id: "rf2", runId: "r", root: "space" as const, ref: null, path: "week.ics", absPath: "/a/week.ics", change: "created" as const, size: 613, insertions: null, deletions: null, kind: "calendar" as const, exists: true, at: 1 },
    { id: "rf3", runId: "r", root: "space" as const, ref: null, path: "old.md", absPath: "/a/old.md", change: "changed" as const, size: 10, insertions: null, deletions: null, kind: "markdown" as const, exists: false, at: 1 },
  ],
};

test("task detail shows the summary and what it made", () => {
  const view = deriveView(makeState(), onTask(ids.review, 1));
  const lines = taskDetail(view, null, outputs, null);
  const all = text(lines);
  expect(all).toContain("Summary");
  expect(all).toContain("Done. Made your list.");
  expect(all).not.toContain("**");
  expect(all).toContain("What it made");
  expect(all).toContain("grocery-list.md  new  2.6 KB");
  expect(all).toContain("no longer in the folder");
  expect(all).toContain("f select a file · o open · R reveal in Finder");
  const picked = text(taskDetail(view, null, outputs, 1)).split("\n");
  expect(picked.find((l) => l.includes("week.ics"))!.startsWith("▸ ")).toBe(true);
  expect(picked.find((l) => l.includes("grocery-list.md  new"))!.startsWith("  ")).toBe(true);
});

test("approval detail renders markdown", () => {
  const state = makeState();
  state.approvals[0]!.detail = "**Done.** See the *list*.";
  const view = deriveView(state, { ...initialUi, selected: { ...initialUi.selected, needs: { id: ids.approval, index: 0 } } });
  expect(text(approvalDetail(view, null))).not.toContain("**");
});
