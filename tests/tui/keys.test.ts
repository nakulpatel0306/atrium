import { expect, test } from "bun:test";
import type { Key } from "ink";
import { join } from "node:path";
import type { State } from "../../src/engine/state";
import { type Command, commandsFor, HELP, type KeyContext, NO_CONTEXT, strip } from "../../src/tui/keys";
import { REMOVED_FEATURE_RETRY } from "../../src/engine/legacy";
import { deriveView } from "../../src/tui/select";
import { initialUi, type Overlay, pin, reduce, type Ui } from "../../src/tui/ui";
import { ids, makeState } from "./fixtures";
import { key } from "./key";

const rows = { detail: 20, live: 10, investRows: 2 };

// Plays keys through commandsFor and the reducer, the way the App does, collecting every command.
function play(steps: (string | [string, Partial<Key>])[], start: Partial<Ui> = {}, state: State = makeState(), ctx: KeyContext = NO_CONTEXT) {
  // Pinned the way the App pins after every change.
  let ui: Ui = pin({ ...initialUi, ...start }, deriveView(state, { ...initialUi, ...start }));
  const all: Command[] = [];
  for (const step of steps) {
    const [input, flags] = typeof step === "string" ? [step, {}] : step;
    const cmds = commandsFor(input, key(flags), ui, deriveView(state, ui), ctx);
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
const flashText = (cmds: Command[]) => uiActions(cmds).flatMap((a) => (a.type === "flash" && a.flash ? [a.flash.text] : []));
const enter: [string, Partial<Key>] = ["", { return: true }];
const esc: [string, Partial<Key>] = ["", { escape: true }];

const spaces: Partial<Ui> = { tab: "spaces" };
// Tasks in atrium, dashboard order: running, review, queued.
const onTask = (index: number, id: string): Partial<Ui> => ({ tab: "spaces", focus: "tasks", lastLeft: "tasks", selected: { ...initialUi.selected, tasks: { id, index } } });
const inJobHunt: Partial<Ui> = { tab: "spaces", selected: { ...initialUi.selected, spaces: { id: ids.jobHunt, index: 1 } } };

test("a chunk of command keys acts once per key", () => {
  expect(uiActions(play(["jj"]).all)).toEqual([
    { type: "move", delta: 1 },
    { type: "move", delta: 1 },
  ]);
  const jq = play(["jq"]).all;
  expect(jq[0]).toEqual({ kind: "ui", action: { type: "move", delta: 1 } });
  expect(jq[1]).toEqual({ kind: "quit" });
});

test("numbers switch tabs; tab and arrows move between Spaces panes", () => {
  expect(play(["2"]).ui.tab).toBe("spaces");
  expect(play(["3"]).ui.tab).toBe("activity");
  expect(play(["3", "1"]).ui.tab).toBe("home");
  expect(uiActions(play([["", { tab: true }]], spaces).all)).toEqual([{ type: "cycle", dir: 1 }]);
  expect(uiActions(play([["", { tab: true, shift: true }]], spaces).all)).toEqual([{ type: "cycle", dir: -1 }]);
  expect(uiActions(play(["l"], spaces).all)).toEqual([{ type: "column", dir: "right" }]);
  expect(uiActions(play([["", { downArrow: true }]]).all)).toEqual([{ type: "move", delta: 1 }]);
  expect(uiActions(play([["d", { ctrl: true }]], spaces).all)).toEqual([{ type: "page", dir: 1 }]);
});

test("a approves the selected card on Home, or the selected task in review", () => {
  const approve = { type: "approve" as const, approvalId: ids.approval, title: "Review: Fix login redirect" };
  expect(play(["a"]).intents).toEqual([approve]);
  expect(play(["a"], onTask(1, ids.review)).intents).toEqual([approve]);
  const queued = play(["a"], onTask(2, ids.queued));
  expect(queued.intents).toEqual([]);
  expect(flashText(queued.all)).toEqual(["Nothing to approve here. Pick a task in review."]);
});

test("r opens the send-back box and enter rejects with the note", () => {
  const opened = play(["r"]);
  expect(opened.ui.ask).toMatchObject({ purpose: "reply", targetId: ids.approval });
  const sent = play(["tighten the tests", enter], { ask: opened.ui.ask });
  expect(sent.intents).toEqual([{ type: "reject", approvalId: ids.approval, note: "tighten the tests" }]);
  expect(sent.ui.ask).toBeNull();
  expect(play([enter], { ask: opened.ui.ask }).intents).toEqual([{ type: "reject", approvalId: ids.approval, note: "" }]);
});

test("enter on a review card opens its task in Spaces", () => {
  const opened = play([enter]);
  expect(opened.ui.tab).toBe("spaces");
  expect(opened.ui.focus).toBe("detail");
  expect(opened.ui.lastLeft).toBe("tasks");
  expect(opened.ui.selected.tasks.id).toBe(ids.review);
});

test("retry and run now only where the dashboard offers them", () => {
  const blocked = { ...inJobHunt, ...onTask(0, ids.blocked), selected: { ...inJobHunt.selected!, tasks: { id: ids.blocked, index: 0 } } };
  expect(play(["R"], blocked).intents).toEqual([{ type: "retry", taskId: ids.blocked }]);
  const running = play(["R"], onTask(0, ids.running));
  expect(running.intents).toEqual([]);
  expect(flashText(running.all)).toEqual(["Retry is for blocked or failed tasks."]);
  const old = makeState();
  old.tasks = old.tasks.map((t) => (t.id === ids.blocked ? { ...t, status: "failed", legacyPurpose: "money" } : t));
  const removed = play(["R"], blocked, old);
  expect(removed.intents).toEqual([]);
  expect(flashText(removed.all)).toEqual([REMOVED_FEATURE_RETRY]);
  expect(play(["s"], onTask(2, ids.queued)).intents).toEqual([{ type: "runNow", taskId: ids.queued }]);
  expect(flashText(play(["s"], onTask(0, ids.running)).all)).toEqual(["Run now is for tasks waiting on Claude's reserve."]);
});

test(". asks before stopping the running task, and y stops it", () => {
  const opened = play(["."], onTask(0, ids.running));
  expect(opened.ui.overlay).toEqual({ kind: "confirm", purpose: "stop", targetId: ids.running });
  expect(play(["y"], { overlay: opened.ui.overlay }).intents).toEqual([{ type: "stop", taskId: ids.running }]);
  expect(play(["n"], { overlay: opened.ui.overlay }).intents).toEqual([]);
  // From the live pane, the space's running task; on Home, the only one running.
  expect(play(["."], { ...spaces, focus: "live" }).ui.overlay).toEqual({ kind: "confirm", purpose: "stop", targetId: ids.running });
  expect(play(["."]).ui.overlay).toEqual({ kind: "confirm", purpose: "stop", targetId: ids.running });
  expect(flashText(play(["."], onTask(2, ids.queued)).all)).toEqual(["That task isn't running."]);
  const none = makeState({ tasks: makeState().tasks.filter((t) => t.status !== "running") });
  expect(flashText(play(["."], {}, none).all)).toEqual(["Nothing is running."]);
});

test("space or : opens the Ask box; on Spaces it adds a task and tab cycles the agent", () => {
  const opened = play([" "], spaces);
  expect(opened.ui.ask).toMatchObject({ purpose: "ask", agent: "auto" });
  expect(play([":"]).ui.ask).toMatchObject({ purpose: "ask" });
  let ask = opened.ui.ask;
  for (const agent of ["claude", "codex", "gemini", "auto"]) {
    ask = play([["", { tab: true }]], { ...spaces, ask }).ui.ask;
    expect(ask).toMatchObject({ agent });
  }
  const sent = play(["Add a README", ["", { tab: true }], enter], { ...spaces, ask: opened.ui.ask });
  expect(sent.intents).toEqual([{ type: "newTask", spaceId: ids.atrium, text: "Add a README", agent: "claude" }]);
  expect(play(["n"], spaces).ui.ask).toMatchObject({ purpose: "ask" });
});

test("on Home the Ask box makes something new, and N does anywhere in Spaces", () => {
  const home = play([" ", "text mom happy birthday", enter]);
  expect(home.intents).toEqual([{ type: "newSpace", text: "text mom happy birthday" }]);
  const space = play(["N"], spaces);
  expect(space.ui.ask).toMatchObject({ purpose: "space" });
  expect(play(["a todo app", enter], { ...spaces, ask: space.ui.ask }).intents).toEqual([{ type: "newSpace", text: "a todo app" }]);
  const empty = play([enter], { ask: space.ui.ask });
  expect(empty.intents).toEqual([]);
  expect(flashText(empty.all)).toEqual(["Type something first, or press esc to cancel."]);
  expect(empty.ui.ask).not.toBeNull();
});

test("keys typed in the Ask box are text, not commands", () => {
  const typed = play([" ", "qa1"]);
  expect(typed.ui.ask?.value).toBe("qa1");
  expect(typed.intents).toEqual([]);
  expect(typed.all.some((c) => c.kind === "quit")).toBe(false);
  expect(play([" ", "x", esc]).ui.ask).toBeNull();
});

test("A picks an agent for a queued work task", () => {
  const opened = play(["A"], onTask(2, ids.queued));
  expect(opened.ui.overlay).toEqual({ kind: "picker", purpose: "agent", targetId: ids.queued, options: ["auto", "claude", "codex", "gemini"], index: 0 });
  const picked = play(["j", enter], { ...onTask(2, ids.queued), overlay: opened.ui.overlay });
  expect(picked.intents).toEqual([{ type: "setAgent", taskId: ids.queued, agent: "claude" }]);
  expect(picked.ui.overlay).toBeNull();
  expect(flashText(play(["A"], onTask(0, ids.running)).all)).toEqual(["This task has already started, so its agent can't change."]);
});

test("q closes an overlay before quitting", () => {
  expect(play(["q"], { overlay: { kind: "help" } }).ui.overlay).toBeNull();
  expect(play(["q"], { overlay: { kind: "help" } }).all.some((c) => c.kind === "quit")).toBe(false);
  expect(play(["q"]).last).toEqual({ kind: "quit" });
  const transcript: Overlay = { kind: "transcript", taskId: ids.review, runIndex: 0, scroll: 0 };
  expect(play([esc], { overlay: transcript }).ui.overlay).toBeNull();
});

test("the filter box filters live", () => {
  const opened = play(["/"], onTask(1, ids.review));
  expect(opened.ui.ask).toMatchObject({ purpose: "filter", targetId: "tasks" });
  const typed = play(["lo"], { ...onTask(1, ids.review), ask: opened.ui.ask });
  expect(uiActions(typed.all)).toContainEqual({ type: "filter", pane: "tasks", text: "lo" });
  expect(typed.ui.filters.tasks).toBe("lo");
  const cancelled = play([esc], typed.ui);
  expect(cancelled.ui.filters.tasks).toBe("");
  expect(cancelled.ui.ask).toBeNull();
  expect(play(["/"]).ui.ask).toMatchObject({ purpose: "filter", targetId: "needs" });
  expect(flashText(play(["/"], { tab: "spaces", focus: "detail" }).all)[0]).toStartWith("Filter works in lists");
});

test("space keys", () => {
  expect(play(["p"], spaces).intents).toEqual([{ type: "private", spaceId: ids.atrium, on: true }]);
  expect(play(["e"], spaces).ui.ask).toMatchObject({ purpose: "goal", value: "Ship the terminal app", targetId: ids.atrium });
  expect(flashText(play(["v"], inJobHunt).all)).toEqual(["Reviews are for repo spaces."]);
  expect(play(["v"], spaces).ui.overlay).toMatchObject({ kind: "picker", purpose: "reviewer", options: ["none", "codex", "gemini", "claude"], index: 1 });
  const confirm = play(["X"], spaces);
  expect(confirm.ui.overlay).toEqual({ kind: "confirm", purpose: "archive", targetId: ids.atrium });
  const yes = play(["y"], { overlay: confirm.ui.overlay });
  expect(yes.intents).toEqual([{ type: "archive", spaceId: ids.atrium }]);
  expect(yes.ui.overlay).toBeNull();
  const no = play(["n"], { overlay: confirm.ui.overlay });
  expect(no.intents).toEqual([]);
  expect(no.ui.overlay).toBeNull();
  // Space keys belong to Spaces; elsewhere they do nothing.
  expect(play(["p"]).intents).toEqual([]);
});

test("t opens the transcript of the selected task's latest run", () => {
  expect(play(["t"], onTask(1, ids.review)).ui.overlay).toEqual({ kind: "transcript", taskId: ids.review, runIndex: 0, scroll: 0 });
  expect(play(["t"]).ui.overlay).toEqual({ kind: "transcript", taskId: ids.review, runIndex: 0, scroll: 0 });
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
  const used = [...source.matchAll(/case "(.)":/g)].map((m) => m[1]!).filter((k) => k !== " ");
  expect(used.length).toBeGreaterThan(20);
  const documented = HELP.map((h) => h.keys).join(" ");
  for (const k of used) expect(documented.split(/\s+/)).toContain(k);
});

test("the key strip follows the tab and the focused pane, and always offers help", () => {
  const state = makeState();
  const keysOf = (u: Ui) => strip(u, deriveView(state, u)).map((k) => `${k.key} ${k.label}`);
  const home = pin(initialUi, deriveView(state, initialUi));
  expect(keysOf(home)).toContain("? help");
  expect(keysOf(home)).toContain("space ask");
  const tasks = { ...home, tab: "spaces" as const, focus: "tasks" as const, lastLeft: "tasks" as const };
  expect(keysOf(tasks)).toContain(". stop");
  expect(keysOf({ ...home, ask: { purpose: "ask", value: "", cursor: 0, agent: "auto", targetId: null } })).toEqual(["enter send", "esc cancel"]);
  expect(keysOf({ ...home, overlay: { kind: "confirm", purpose: "stop", targetId: ids.running } })).toEqual(["y stop it", "n keep running"]);
});

test("actions wait for a picked card", () => {
  const cleared: Partial<Ui> = { selected: { ...initialUi.selected, needs: { id: "", index: 0 } } };
  const a = play(["a"], cleared);
  expect(a.intents).toEqual([]);
  expect(flashText(a.all)).toEqual(["Select an item first: press j or k."]);
  expect(play(["j", "a"], cleared).intents).toMatchObject([{ type: "approve", approvalId: ids.approval }]);
  const state = makeState();
  const ui = { ...initialUi, ...cleared } as Ui;
  expect(strip(ui, deriveView(state, ui))[0]).toMatchObject({ key: "j k", label: "select an item" });
});

const files = [
  { path: "grocery-list.md", exists: true, root: "space" as const },
  { path: "week.ics", exists: true, root: "space" as const },
];
const withFiles = (list = files): KeyContext => ({ ...NO_CONTEXT, files: list });
const inDetail = (index: number, id: string): Partial<Ui> => ({ ...onTask(index, id), focus: "detail", lastLeft: "tasks" });

test("f picks a made file, then o opens it and R reveals it", () => {
  const start = inDetail(1, ids.review);
  const s = makeState();
  expect(play(["f"], start, s, withFiles()).ui.detailFile).toBe(0);
  expect(play(["f", "f", "f"], start, s, withFiles()).ui.detailFile).toBe(0);
  expect(play(["F"], start, s, withFiles()).ui.detailFile).toBe(1);
  expect(play(["f", "o"], start, s, withFiles()).intents).toEqual([{ type: "openFile", spaceId: ids.atrium, path: "grocery-list.md", how: "open", name: "grocery-list.md" }]);
  expect(play(["f", "f", "R"], start, s, withFiles()).intents).toEqual([{ type: "openFile", spaceId: ids.atrium, path: "week.ics", how: "reveal", name: "week.ics" }]);
});

test("with no file picked, o and R keep their usual meaning", () => {
  const start = inDetail(1, ids.review);
  expect(play(["o"], start, makeState(), withFiles()).intents[0]?.type).toBe("overnight");
  expect(flashText(play(["R"], start, makeState(), withFiles()).all)).toContain("Retry is for blocked or failed tasks.");
  expect(flashText(play(["f"], start, makeState(), withFiles([])).all)).toContain("This task didn't make any files.");
});

test("esc clears the file before leaving detail", () => {
  const start = inDetail(1, ids.review);
  const once = play(["f", esc], start, makeState(), withFiles()).ui;
  expect(once.detailFile).toBeNull();
  expect(once.focus).toBe("detail");
  expect(play(["f", esc, esc], start, makeState(), withFiles()).ui.focus).toBe("tasks");
});

test("Activity: enter opens the picked line's space", () => {
  const opened = play(["j", enter], { tab: "activity" });
  expect(opened.ui.tab).toBe("spaces");
  expect(opened.ui.selected.spaces.id).toBe(ids.jobHunt);
});
