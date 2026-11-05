import { expect, test } from "bun:test";
import type { Key } from "ink";
import { join } from "node:path";
import type { State } from "../../src/engine/state";
import { type Command, commandsFor, HELP, hints } from "../../src/tui/keys";
import { deriveView } from "../../src/tui/select";
import { initialUi, type Overlay, pin, reduce, type Ui } from "../../src/tui/ui";
import { ids, makeState } from "./fixtures";
import { key } from "./key";

const rows = { detail: 20, live: 10 };

// Plays keys through commandsFor and the reducer, the way the App does, collecting every command.
function play(steps: (string | [string, Partial<Key>])[], start: Partial<Ui> = {}, state: State = makeState()) {
  // Pinned the way the App pins after every change.
  let ui: Ui = pin({ ...initialUi, ...start }, deriveView(state, { ...initialUi, ...start }));
  const all: Command[] = [];
  for (const step of steps) {
    const [input, flags] = typeof step === "string" ? [step, {}] : step;
    const cmds = commandsFor(input, key(flags), ui, deriveView(state, ui));
    all.push(...cmds);
    for (const c of cmds) {
      if (c.kind !== "ui") continue;
      const next = reduce(ui, c.action, deriveView(state, ui), rows);
      ui = pin(next, deriveView(state, next));
    }
  }
  return { ui, all, intents: all.flatMap((c) => (c.kind === "intent" ? [c.intent] : [])), last: all.at(-1) };
}

const uiActions = (cmds: Command[]) => cmds.flatMap((c) => (c.kind === "ui" ? [c.action] : []));
const flashText = (cmds: Command[]) =>
  uiActions(cmds).flatMap((a) => (a.type === "flash" && a.flash ? [a.flash.text] : []));

// Tasks in atrium, dashboard order: running, review, queued.
const onTask = (index: number, id: string): Partial<Ui> => ({
  focus: "tasks",
  lastLeft: "tasks",
  selected: { ...initialUi.selected, tasks: { id, index } },
});
const inJobHunt: Partial<Ui> = { selected: { ...initialUi.selected, spaces: { id: ids.jobHunt, index: 1 } } };

test("a chunk of command keys acts once per key", () => {
  expect(uiActions(play(["jj"]).all)).toEqual([
    { type: "move", delta: 1 },
    { type: "move", delta: 1 },
  ]);
  const jq = play(["jq"]).all;
  expect(jq[0]).toEqual({ kind: "ui", action: { type: "move", delta: 1 } });
  expect(jq[1]).toEqual({ kind: "quit" });
});

test("arrows, numbers, and tab focus panes", () => {
  expect(play(["3"]).ui.focus).toBe("needs");
  expect(play(["0"]).ui.focus).toBe("detail");
  expect(play(["5"]).ui.focus).toBe("live");
  expect(uiActions(play([["", { tab: true }]]).all)).toEqual([{ type: "cycle", dir: 1 }]);
  expect(uiActions(play([["", { tab: true, shift: true }]]).all)).toEqual([{ type: "cycle", dir: -1 }]);
  expect(uiActions(play(["l"]).all)).toEqual([{ type: "column", dir: "right" }]);
  expect(uiActions(play([["", { downArrow: true }]]).all)).toEqual([{ type: "move", delta: 1 }]);
  expect(uiActions(play([["d", { ctrl: true }]]).all)).toEqual([{ type: "page", dir: 1 }]);
});

test("a approves the selected approval", () => {
  const approve = { type: "approve" as const, approvalId: ids.approval, title: "Review: Fix login redirect" };
  expect(play(["3", "a"]).intents).toEqual([approve]);
  expect(play(["a"], onTask(1, ids.review)).intents).toEqual([approve]);
  const queued = play(["a"], onTask(2, ids.queued));
  expect(queued.intents).toEqual([]);
  expect(flashText(queued.all)).toEqual(["Nothing to approve here. Pick a row in Needs you [3]."]);
});

test("r opens the send-back prompt and enter rejects with the note", () => {
  const opened = play(["3", "r"]);
  expect(opened.ui.overlay).toMatchObject({ kind: "prompt", purpose: "reply", targetId: ids.approval });
  const sent = play(["tighten the tests", ["", { return: true }]], { overlay: opened.ui.overlay });
  expect(sent.intents).toEqual([{ type: "reject", approvalId: ids.approval, note: "tighten the tests" }]);
  expect(sent.ui.overlay).toBeNull();
  expect(play([["", { return: true }]], { overlay: opened.ui.overlay }).intents).toEqual([
    { type: "reject", approvalId: ids.approval, note: "" },
  ]);
});

test("retry and run now only where the dashboard offers them", () => {
  const blocked = { ...inJobHunt, ...onTask(0, ids.blocked), selected: { ...inJobHunt.selected!, tasks: { id: ids.blocked, index: 0 } } };
  expect(play(["R"], blocked).intents).toEqual([{ type: "retry", taskId: ids.blocked }]);
  const running = play(["R"], onTask(0, ids.running));
  expect(running.intents).toEqual([]);
  expect(flashText(running.all)).toEqual(["Retry is for blocked or failed tasks."]);
  expect(play(["s"], onTask(2, ids.queued)).intents).toEqual([{ type: "runNow", taskId: ids.queued }]);
  expect(flashText(play(["s"], onTask(0, ids.running)).all)).toEqual(["Run now is for tasks waiting on Claude's reserve."]);
});

test("n and N open prompts; tab cycles the agent", () => {
  const opened = play(["n"]);
  expect(opened.ui.overlay).toMatchObject({ kind: "prompt", purpose: "task", targetId: ids.atrium, agent: "auto" });
  let overlay = opened.ui.overlay;
  for (const agent of ["claude", "codex", "gemini", "auto"]) {
    overlay = play([["", { tab: true }]], { overlay }).ui.overlay;
    expect(overlay).toMatchObject({ agent });
  }
  const sent = play(["Add a README", ["", { tab: true }], ["", { return: true }]], { overlay: opened.ui.overlay });
  expect(sent.intents).toEqual([{ type: "newTask", spaceId: ids.atrium, text: "Add a README", agent: "claude" }]);

  const space = play(["N"]);
  expect(space.ui.overlay).toMatchObject({ kind: "prompt", purpose: "space" });
  expect(play(["a todo app", ["", { return: true }]], { overlay: space.ui.overlay }).intents).toEqual([
    { type: "newSpace", text: "a todo app" },
  ]);
  const empty = play([["", { return: true }]], { overlay: space.ui.overlay });
  expect(empty.intents).toEqual([]);
  expect(flashText(empty.all)).toEqual(["Type something first, or press esc to cancel."]);
  expect(empty.ui.overlay).not.toBeNull();
});

test("A picks an agent for a queued work task", () => {
  const opened = play(["A"], onTask(2, ids.queued));
  expect(opened.ui.overlay).toEqual({ kind: "picker", purpose: "agent", targetId: ids.queued, options: ["auto", "claude", "codex", "gemini"], index: 0 });
  const picked = play(["j", ["", { return: true }]], { ...onTask(2, ids.queued), overlay: opened.ui.overlay });
  expect(picked.intents).toEqual([{ type: "setAgent", taskId: ids.queued, agent: "claude" }]);
  expect(picked.ui.overlay).toBeNull();
  expect(flashText(play(["A"], onTask(0, ids.running)).all)).toEqual(["This task has already started, so its agent can't change."]);
});

test("q closes an overlay before quitting", () => {
  expect(play(["q"], { overlay: { kind: "help" } }).ui.overlay).toBeNull();
  expect(play(["q"], { overlay: { kind: "help" } }).all.some((c) => c.kind === "quit")).toBe(false);
  expect(play(["q"]).last).toEqual({ kind: "quit" });
  const transcript: Overlay = { kind: "transcript", taskId: ids.review, runIndex: 0, scroll: 0 };
  expect(play([["", { escape: true }]], { overlay: transcript }).ui.overlay).toBeNull();
});

test("filter prompt filters live", () => {
  const opened = play(["2", "/"]);
  expect(opened.ui.overlay).toMatchObject({ kind: "prompt", purpose: "filter" });
  const typed = play(["lo"], { focus: "tasks", lastLeft: "tasks", overlay: opened.ui.overlay });
  expect(uiActions(typed.all)).toContainEqual({ type: "filter", pane: "tasks", text: "lo" });
  expect(typed.ui.filters.tasks).toBe("lo");
  const cancelled = play([["", { escape: true }]], typed.ui);
  expect(cancelled.ui.filters.tasks).toBe("");
  expect(cancelled.ui.overlay).toBeNull();
});

test("space keys", () => {
  expect(play(["p"]).intents).toEqual([{ type: "private", spaceId: ids.atrium, on: true }]);
  expect(play(["e"]).ui.overlay).toMatchObject({ kind: "prompt", purpose: "goal", value: "Ship the terminal app", targetId: ids.atrium });
  expect(flashText(play(["v"], inJobHunt).all)).toEqual(["Reviews are for repo spaces."]);
  expect(play(["v"]).ui.overlay).toMatchObject({ kind: "picker", purpose: "reviewer", options: ["none", "codex", "gemini", "claude"], index: 1 });
  const confirm = play(["X"]);
  expect(confirm.ui.overlay).toEqual({ kind: "confirm", purpose: "archive", targetId: ids.atrium });
  const yes = play(["y"], { overlay: confirm.ui.overlay });
  expect(yes.intents).toEqual([{ type: "archive", spaceId: ids.atrium }]);
  expect(yes.ui.overlay).toBeNull();
  const no = play(["n"], { overlay: confirm.ui.overlay });
  expect(no.intents).toEqual([]);
  expect(no.ui.overlay).toBeNull();
});

test("t opens the transcript of the selected task's latest run", () => {
  expect(play(["t"], onTask(1, ids.review)).ui.overlay).toEqual({ kind: "transcript", taskId: ids.review, runIndex: 0, scroll: 0 });
  expect(flashText(play(["t"], onTask(2, ids.queued)).all)).toEqual(["No runs yet."]);
});

test("any key clears the flash", () => {
  const cmds = play(["j"], { flash: { text: "hi", tone: "info" } }).all;
  expect(uiActions(cmds)).toEqual([
    { type: "flash", flash: null },
    { type: "move", delta: 1 },
  ]);
});

test("help covers every key", async () => {
  const source = await Bun.file(join(import.meta.dir, "../../src/tui/keys.ts")).text();
  const used = [...source.matchAll(/case "(.)":/g)].map((m) => m[1]!);
  expect(used.length).toBeGreaterThan(20);
  const documented = HELP.map((h) => h.keys).join(" ");
  for (const k of used) expect(documented.split(/\s+/)).toContain(k);
});

test("hints follow the focused pane", () => {
  const state = makeState();
  const needs = { ...initialUi, focus: "needs" as const, lastLeft: "needs" as const };
  expect(hints(needs, deriveView(state, needs))).toContain("a approve");
  expect(hints(initialUi, deriveView(state, initialUi))).toContain("n new task");
});

test("actions wait for a picked row", () => {
  const cleared: Partial<Ui> = { focus: "needs", lastLeft: "needs", selected: { ...initialUi.selected, needs: { id: "", index: 0 } } };
  const a = play(["a"], cleared);
  expect(a.intents).toEqual([]);
  expect(flashText(a.all)).toEqual(["Select an item first: press j or k."]);
  expect(play(["j", "a"], cleared).intents).toMatchObject([{ type: "approve", approvalId: ids.approval }]);
  const state = makeState();
  const ui = { ...initialUi, ...cleared } as Ui;
  expect(hints(ui, deriveView(state, ui)).startsWith("j k select an item")).toBe(true);
});

test("help comes first in the status bar", () => {
  const state = makeState();
  const ui = pin(initialUi, deriveView(state, initialUi));
  expect(hints(ui, deriveView(state, ui)).startsWith("? help  ")).toBe(true);
});
