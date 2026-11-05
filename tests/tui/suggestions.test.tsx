import { afterEach, expect, test } from "bun:test";
import { cleanup } from "ink-testing-library";
import { activityDetail, proposalDetail } from "../../src/tui/detail";
import { runIntent } from "../../src/tui/effects";
import { commandsFor } from "../../src/tui/keys";
import { deriveView } from "../../src/tui/select";
import { initialUi, pin, type Ui } from "../../src/tui/ui";
import { type FakeClient, fakeClient } from "./fake-client";
import { ids, makeState, proposal } from "./fixtures";
import { openApp } from "./harness";
import { key } from "./key";

afterEach(() => cleanup());

const withSuggestion = () => makeState({ proposals: [proposal()] });
const onNeeds = (state = withSuggestion()): Ui => {
  const ui: Ui = { ...initialUi, focus: "needs", lastLeft: "needs" };
  return pin(ui, deriveView(state, ui));
};
const text = (lines: { text: string }[][]) => lines.map((l) => l.map((s) => s.text).join("")).join("\n");
const mutations = (calls: FakeClient["calls"]) => calls.filter((c) => c.method !== "GET" && c.path !== "/api/seen");

test("suggestions come first in Needs you, as their own kind of row", () => {
  const state = withSuggestion();
  const view = deriveView(state, onNeeds(state));
  expect(view.proposals.map((p) => p.id)).toEqual([ids.proposal]);
  expect(view.proposal?.id).toBe(ids.proposal);
  expect(view.approval).toBeNull();
});

test("y, n, and N answer the selected suggestion", () => {
  const state = withSuggestion();
  const ui = onNeeds(state);
  const answer = (input: string) => commandsFor(input, key(input === "N" ? { shift: true } : {}), ui, deriveView(state, ui));
  for (const [input, value] of [["y", "yes"], ["n", "not_now"], ["N", "never"]] as const) {
    expect(answer(input)).toEqual([
      { kind: "intent", intent: { type: "answer", proposalId: ids.proposal, answer: value, label: "docs-only changes" } },
    ]);
  }
  expect(answer("a")).toEqual([
    { kind: "ui", action: { type: "flash", flash: { tone: "info", text: "That's a suggestion: y yes, n not now, N never." } } },
  ]);
});

test("n and N still make a task and a space outside a suggestion", () => {
  const state = withSuggestion();
  const ui = pin(initialUi, deriveView(state, initialUi));
  expect(commandsFor("n", key(), ui, deriveView(state, ui))[0]).toMatchObject({ kind: "ui", action: { type: "open", overlay: { purpose: "task" } } });
  expect(commandsFor("N", key(), ui, deriveView(state, ui))[0]).toMatchObject({ kind: "ui", action: { type: "open", overlay: { purpose: "space" } } });
});

test("answers go to the suggestion endpoint and read plainly", async () => {
  const state = withSuggestion();
  const cases = [
    ["yes", "Atrium will approve docs-only changes in atrium on its own. Undo any of them, or turn the rule off, on the dashboard's Rules page."],
    ["not_now", "Not now. Atrium will keep asking about docs-only changes."],
    ["never", "Atrium won't suggest a rule for docs-only changes again."],
  ] as const;
  for (const [answer, said] of cases) {
    const client = fakeClient(state);
    const flash = await runIntent(client, { type: "answer", proposalId: ids.proposal, answer, label: "docs-only changes" }, state);
    expect(client.calls).toEqual([{ method: "POST", path: `/api/proposals/${ids.proposal}`, body: { answer } }]);
    expect(flash).toEqual({ tone: "ok", text: said });
  }
});

test("suggestion detail explains what yes means", () => {
  const state = withSuggestion();
  const all = text(proposalDetail(deriveView(state, onNeeds(state))));
  expect(all).toContain("Stop asking about docs-only changes?");
  expect(all).toContain("You approved the last 5 without changes.");
  expect(all).toContain("never merges or pushes");
  expect(all).toContain("Review: Update README 1");
  expect(all).toContain("y yes · n not now · N never");
});

test("approvals made by a rule say so", () => {
  const state = makeState();
  state.activity[0] = { ...state.activity[0]!, actor: "atrium", message: 'Approved by your rule "docs-only changes": Review: Update README' };
  const ui: Ui = { ...initialUi, focus: "activity", lastLeft: "activity" };
  const all = text(activityDetail(deriveView(state, pin(ui, deriveView(state, ui)))));
  expect(all).toContain("approved by your rule");
  expect(all).toContain("Rules page");
});

test("a suggestion in the app: row, detail, and y", async () => {
  const client = fakeClient(withSuggestion());
  const app = openApp(client);
  const f = await app.frame((f) => f.includes("[3] Needs you · 2"));
  // Truncated to the pane; the detail has the whole label.
  expect(f).toContain("✦ Stop asking about docs-only chan");
  await app.type("3");
  await app.frame((f) => f.includes("[0] Detail · Suggestion · docs-only changes"));
  await app.type("y");
  await app.frame((f) => f.includes("Atrium will approve docs-only changes"));
  expect(mutations(client.calls)).toEqual([{ method: "POST", path: `/api/proposals/${ids.proposal}`, body: { answer: "yes" } }]);
});

test("a rule's approval is labelled in the activity list", async () => {
  const state = makeState();
  state.activity[0] = { ...state.activity[0]!, actor: "atrium", message: 'Approved by your rule "docs-only changes": Review: Update README' };
  const app = openApp(fakeClient(state));
  const f = await app.frame((f) => f.includes("[4] Activity"));
  expect(f).toContain("Your rule · atrium");
});
