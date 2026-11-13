// What every key does, as a pure function of the key, the UI state, and what's on screen.
import type { Key } from "ink";
import { AGENT_CHOICES, type AgentChoice, waitOf } from "../dashboard/agents";
import { nameMatches } from "../dashboard/deletion";
import type { ReviewerId } from "../engine/spaces";
import { editLine } from "./edit";
import { listOf, pick, type View } from "./select";
import { type Action, type Ask, type AskPurpose, listPaneOf, type ListPane, type Overlay, TABS, type Ui } from "./ui";

export type Intent =
  | { type: "approve"; approvalId: string; title: string }
  | { type: "reject"; approvalId: string; note: string }
  | { type: "retry"; taskId: string }
  | { type: "runNow"; taskId: string }
  | { type: "stop"; taskId: string }
  | { type: "newTask"; spaceId: string; text: string; agent: AgentChoice }
  | { type: "newSpace"; text: string }
  | { type: "setAgent"; taskId: string; agent: AgentChoice }
  | { type: "overnight"; on: boolean }
  | { type: "reserve"; value: 0.25 | 0.5 | 0.75 }
  | { type: "private"; spaceId: string; on: boolean }
  | { type: "goal"; spaceId: string; goal: string }
  | { type: "reviewer"; spaceId: string; reviewBy: ReviewerId | null }
  | { type: "archive"; spaceId: string }
  | { type: "restore"; spaceId: string }
  | { type: "deleteSpace"; spaceId: string; name: string }
  | { type: "answer"; proposalId: string; answer: "yes" | "not_now" | "never"; label: string }
  | { type: "openFile"; spaceId: string; path: string; how: "open" | "reveal"; name: string }
  | { type: "dismissNudge"; spaceId: string; nudgeId: string }
  | { type: "explain"; spaceId: string; month: string }
  | { type: "moneyAsk"; spaceId: string; question: string }
  | { type: "budget"; spaceId: string; category: string; limit: number | null }
  | { type: "importPreview"; spaceId: string; path: string }
  | { type: "importCsv"; spaceId: string; csv: string; account: string }
  | { type: "investAsk"; spaceId: string; key: string; question: string };

// A file the selected task made, as the keys need it.
export type MadeFile = { path: string; exists: boolean; root: "space" | "branch" };

// What the fetched Money and Investing views hold, as the keys need it.
export type KeyContext = {
  files: MadeFile[];
  money: { spaceId: string; month: string | null; months: string[]; categories: string[] } | null;
  invest: { spaceId: string; keys: string[] } | null;
};

export const NO_CONTEXT: KeyContext = { files: [], money: null, invest: null };

export type Command = { kind: "ui"; action: Action } | { kind: "intent"; intent: Intent } | { kind: "quit" };

type Section = "Everywhere" | "Home" | "Spaces" | "Money" | "Investing" | "Activity";

export const HELP: { section: Section; keys: string; does: string }[] = [
  { section: "Everywhere", keys: "1 2 3 4 5", does: "switch tab" },
  { section: "Everywhere", keys: "space or :", does: "type in the Ask box" },
  { section: "Everywhere", keys: "j k ↑ ↓", does: "move or scroll" },
  { section: "Everywhere", keys: "g G", does: "top, bottom" },
  { section: "Everywhere", keys: "enter", does: "open" },
  { section: "Everywhere", keys: "esc", does: "back, clear filter" },
  { section: "Everywhere", keys: "/", does: "filter the list" },
  { section: "Everywhere", keys: "u", does: "agents and usage" },
  { section: "Everywhere", keys: "o", does: "overnight on / off" },
  { section: "Everywhere", keys: "? q", does: "help, close, quit" },
  // Mouse reporting takes plain drags, so selecting text needs the terminal's own modifier.
  { section: "Everywhere", keys: "Opt/Shift", does: "drag to select text" },
  { section: "Home", keys: "s e x", does: "text: send, edit, skip" },
  { section: "Home", keys: "a r", does: "approve, send back" },
  { section: "Home", keys: "y n N", does: "yes, not now, never" },
  { section: "Home", keys: "t", does: "transcript" },
  { section: "Home", keys: ".", does: "stop running task" },
  { section: "Spaces", keys: "tab h l", does: "move between panes" },
  { section: "Spaces", keys: "n N", does: "new task, new space" },
  { section: "Spaces", keys: "a r", does: "approve, send back" },
  { section: "Spaces", keys: "R s", does: "retry, run now" },
  { section: "Spaces", keys: ".", does: "stop running task" },
  { section: "Spaces", keys: "A", does: "change agent" },
  { section: "Spaces", keys: "t [ ]", does: "transcript, runs" },
  { section: "Spaces", keys: "f F", does: "pick a made file" },
  { section: "Spaces", keys: "o R", does: "open, reveal file" },
  { section: "Spaces", keys: "p e v", does: "private, goal, reviewer" },
  { section: "Spaces", keys: "X D", does: "archive, delete" },
  { section: "Spaces", keys: "ctrl-d/u", does: "half page" },
  { section: "Money", keys: "← → [ ]", does: "earlier, later month" },
  { section: "Money", keys: "b", does: "set a budget" },
  { section: "Money", keys: "e", does: "explain my month" },
  { section: "Money", keys: "i", does: "import a CSV" },
  { section: "Investing", keys: "j k", does: "pick a symbol" },
  { section: "Activity", keys: "enter", does: "open its space" },
  { section: "Activity", keys: "ctrl-d/u", does: "scroll its lines" },
];

const SECTION: Record<Ui["tab"], Section> = { home: "Home", spaces: "Spaces", money: "Money", investing: "Investing", activity: "Activity" };
export const helpFor = (tab: Ui["tab"]) => HELP.filter((h) => h.section === "Everywhere" || h.section === SECTION[tab]);

// One key cap on the strip. `input` is what a click on it presses; none for keys a click can't stand for.
export type StripKey = { key: string; label: string; input?: string };

const k = (key: string, label: string, input: string | undefined = key): StripKey => ({ key, label, input });
const MOVE = k("↑↓", "move", undefined);
const HELP_KEY = k("?", "help");

const OVERLAY_KEYS: Partial<Record<Overlay["kind"], StripKey[]>> = {
  transcript: [k("j k", "scroll", undefined), k("g G", "top / end", undefined), k("[ ]", "older / newer", undefined), k("q", "close")],
  agents: [k("[ ]", "pause point", undefined), k("o", "overnight"), k("j k", "scroll", undefined), k("q", "close")],
  detail: [k("j k", "scroll", undefined), k("a", "approve"), k("r", "send back"), k("q", "close")],
  help: [k("?", "close")],
  picker: [k("j k", "move", undefined), k("enter", "pick", "\r"), k("esc", "cancel", "\x1b")],
  delete: [k("enter", "delete", "\r"), k("esc", "keep it", "\x1b")],
};

// The key strip: what the keys do right now, always on screen.
export function strip(ui: Ui, view: View): StripKey[] {
  if (ui.ask) {
    const keys = [k("enter", "send", "\r"), k("esc", "cancel", "\x1b")];
    if (askAgentCycles(ui, view)) keys.push(k("tab", "agent", "\t"));
    return keys;
  }
  if (ui.overlay?.kind === "confirm") {
    const yes = { accept: "accept", archive: "archive", stop: "stop it", import: "import" }[ui.overlay.purpose];
    return [k("y", yes), k("n", ui.overlay.purpose === "stop" ? "keep running" : "not now")];
  }
  const overlay = ui.overlay && OVERLAY_KEYS[ui.overlay.kind];
  if (overlay) return overlay;
  const pane = listPaneOf(ui);
  const list = pane ? listOf(view, pane) : [];
  const lead = pane && list.length > 0 && !pick(list, ui.selected[pane]).item ? [k("j k", "select an item", "j")] : [MOVE];
  const ask = k("space", "ask", " ");
  switch (ui.tab) {
    case "home":
      return [...lead, k("↵", "open", "\r"), ask, k("1-5", "views", undefined), k("/", "filter"), HELP_KEY, k("q", "quit")];
    case "spaces":
      if (ui.focus === "spaces") return [...lead, k("↵", "tasks", "\r"), k("n", "new task"), k("N", "new space"), k("e", "goal"), k("X", "archive"), k("D", "delete"), HELP_KEY];
      if (ui.focus === "tasks") return [...lead, k("↵", "detail", "\r"), k("n", "new task"), k("R", "retry"), k("s", "run now"), k(".", "stop"), k("A", "agent"), k("t", "transcript"), HELP_KEY];
      if (ui.focus === "detail") return [k("j k", "scroll", undefined), k("a", "approve"), k("r", "send back"), k("f", "files"), k("t", "transcript"), k("esc", "back", "\x1b"), HELP_KEY];
      return [k("j k", "scroll", undefined), k("g G", "top / follow", undefined), k(".", "stop"), k("esc", "back", "\x1b"), HELP_KEY];
    case "money":
      return [k("←→", "month", undefined), k("↑↓", "category", undefined), k("b", "budget"), k("e", "explain"), k("i", "import"), ask, HELP_KEY];
    case "investing":
      return [k("↑↓", "pick a symbol", undefined), k("space", "ask about it", " "), k("u", "usage"), HELP_KEY, k("q", "quit")];
    case "activity":
      return [...lead, k("↵", "open space", "\r"), k("/", "filter"), k("ctrl-d", "scroll lines", undefined), HELP_KEY, k("q", "quit")];
  }
}

const REVIEWER_OPTIONS = ["none", "codex", "gemini", "claude"];
const NO_SPACE = "Pick a space first, or press N to describe a new one.";
const NO_TASK = "Pick a task in Spaces first.";
const NO_INVESTING = "There's no Investing space yet. Press space and ask Atrium to set one up, like \"track my investing\".";

const ui = (action: Action): Command => ({ kind: "ui", action });
const intent = (i: Intent): Command => ({ kind: "intent", intent: i });
const info = (text: string): Command => ui({ type: "flash", flash: { tone: "info", text } });
const open = (overlay: Overlay): Command => ui({ type: "open", overlay });
const close: Command = ui({ type: "close" });
const ask = (purpose: AskPurpose, targetId: string | null = null, value = ""): Command =>
  ui({ type: "ask", ask: { purpose, value, cursor: value.length, agent: "auto", targetId } });
const leaveAsk: Command = ui({ type: "ask", ask: null });

const pinnedSuggestion = (u: Ui, view: View) => view.proposal && u.selected.needs.id === view.proposal.id;

// Actions act only on a row pinned by id, never on whatever happens to sit at the cursor's position.
const pinned = <T extends { id: string }>(u: Ui, pane: ListPane, item: T | null): T | null => (item && u.selected[pane].id === item.id ? item : null);

const spaceOf = (u: Ui, view: View) => (u.tab === "spaces" ? pinned(u, "spaces", view.space) : null);

function approvalOf(u: Ui, view: View) {
  if (u.tab === "home") return pinned(u, "needs", view.approval);
  const task = u.tab === "spaces" && u.lastLeft === "tasks" ? pinned(u, "tasks", view.task) : null;
  return task?.approvalId ? (view.state.approvals.find((a) => a.id === task.approvalId) ?? null) : null;
}

function taskOf(u: Ui, view: View) {
  if (u.tab === "spaces" && u.lastLeft === "tasks") return pinned(u, "tasks", view.task);
  const approval = u.tab === "home" ? pinned(u, "needs", view.approval) : null;
  return approval?.taskId ? (view.state.tasks.find((t) => t.id === approval.taskId) ?? null) : null;
}

// Why a key found nothing to act on: an empty list, or rows with none picked.
function nothingHere(u: Ui, view: View, empty: string): Command {
  const pane = listPaneOf(u) ?? (u.tab === "spaces" ? u.lastLeft : null);
  if (pane && listOf(view, pane).length > 0 && !pick(listOf(view, pane), u.selected[pane]).item) return info("Select an item first: press j or k.");
  return info(empty);
}

function transcript(u: Ui, view: View): Command {
  const task = taskOf(u, view);
  if (!task) return nothingHere(u, view, NO_TASK);
  if (!view.state.runs.some((r) => r.taskId === task.id)) return info("No runs yet.");
  return open({ kind: "transcript", taskId: task.id, runIndex: 0, scroll: 0 });
}

// A task to stop: the one picked in Spaces, or on Home the only one running.
function stop(u: Ui, view: View): Command {
  const running = view.state.tasks.filter((t) => t.status === "running");
  let task = taskOf(u, view);
  if (u.tab === "spaces" && (u.focus === "live" || (u.focus !== "tasks" && !task))) task = view.live?.task ?? task;
  if (u.tab === "home") {
    if (running.length === 0) return info("Nothing is running.");
    if (running.length > 1) return info("More than one task is running. Pick the one to stop in Spaces.");
    task = running[0]!;
  }
  if (!task) return nothingHere(u, view, NO_TASK);
  if (task.status !== "running") return info("That task isn't running.");
  return open({ kind: "confirm", purpose: "stop", targetId: task.id });
}

// Approve: a result the agent said it didn't finish asks first.
function approve(u: Ui, view: View): Command {
  const approval = approvalOf(u, view);
  if (!approval) return nothingHere(u, view, u.tab === "home" ? "Nothing to approve here." : "Nothing to approve here. Pick a task in review.");
  const outcome = approval.kind === "review" && approval.taskId ? view.state.tasks.find((t) => t.id === approval.taskId)?.outcome : null;
  if (outcome === "couldnt" || outcome === "partial") return open({ kind: "confirm", purpose: "accept", targetId: approval.id });
  return intent({ type: "approve", approvalId: approval.id, title: approval.title });
}

function sendBack(u: Ui, view: View): Command {
  const approval = approvalOf(u, view);
  if (!approval) return nothingHere(u, view, "Nothing to send back here.");
  if (approval.kind === "alert") return info("Price alerts are dismissed with a; turn one off on the dashboard.");
  return ask("reply", approval.id);
}

const ANSWERS = { y: "yes", n: "not_now", N: "never" } as const;

// Keys on Home's selected card.
function homeKey(input: string, key: Key, u: Ui, view: View): Command[] | null {
  const suggestion = pinnedSuggestion(u, view) ? view.proposal : null;
  if (suggestion) {
    if (input === "y" || input === "n" || input === "N") return [intent({ type: "answer", proposalId: suggestion.id, answer: ANSWERS[input], label: suggestion.label })];
    if (input === "a" || input === "r") return [info("That's a suggestion: y yes, n not now, N never.")];
    if (key.return) return [open({ kind: "detail", scroll: 0 })];
  }
  const nudge = view.nudge && u.selected.needs.id === view.nudge.id ? view.nudge : null;
  if (nudge) {
    if (input === "x") return [intent({ type: "dismissNudge", spaceId: nudge.spaceId, nudgeId: nudge.id })];
    if (key.return || input === "i") return [ui({ type: "tab", tab: "money" })];
  }
  const approval = pinned(u, "needs", view.approval);
  if (!approval) return null;
  if (key.return) {
    // A review opens on its task, where its runs, files and thread are; anything else opens its full text here.
    const task = approval.kind === "review" && approval.taskId ? view.state.tasks.find((t) => t.id === approval.taskId) : undefined;
    const index = task ? view.spaces.findIndex((s) => s.id === task.spaceId) : -1;
    if (task && index >= 0) {
      return [
        ui({ type: "select", pane: "spaces", id: task.spaceId }),
        ui({ type: "focus", pane: "tasks" }),
        ui({ type: "select", pane: "tasks", id: task.id }),
        ui({ type: "focus", pane: "detail" }),
      ];
    }
    return [open({ kind: "detail", scroll: 0 })];
  }
  return null;
}

// f, F, o and R on the files a task made, while its detail has focus. Null when the key means something else.
function fileKey(input: string, u: Ui, view: View, files: MadeFile[]): Command[] | null {
  if (u.tab !== "spaces" || u.focus !== "detail" || view.subject !== "task" || !view.task) return null;
  if (input === "f" || input === "F") {
    if (!files.length) return [info("This task didn't make any files.")];
    const step = input === "f" ? 1 : -1;
    const at = u.detailFile === null ? (step === 1 ? 0 : files.length - 1) : (u.detailFile + step + files.length) % files.length;
    return [ui({ type: "file", index: at })];
  }
  const file = u.detailFile !== null ? files[u.detailFile] : undefined;
  if ((input === "o" || input === "R") && file) {
    const name = file.path.slice(file.path.lastIndexOf("/") + 1);
    return [intent({ type: "openFile", spaceId: view.task.spaceId, path: file.path, how: input === "o" ? "open" : "reveal", name })];
  }
  return null;
}

function moneyKey(input: string, key: Key, u: Ui, ctx: KeyContext): Command[] | null {
  const m = ctx.money;
  const earlier = key.leftArrow || input === "[" || input === "h";
  const later = key.rightArrow || input === "]" || input === "l";
  if (!earlier && !later && !["b", "e", "i"].includes(input)) return null;
  if (!m) return [info(NO_INVESTING)];
  if (input === "i") return [ask("import", m.spaceId)];
  if (earlier || later) {
    // Months are listed newest first.
    const at = m.month ? m.months.indexOf(m.month) : -1;
    const next = m.months[at + (earlier ? 1 : -1)];
    if (at < 0 || next === undefined) return [info(earlier ? "That's the earliest month imported." : "That's the latest month imported.")];
    return [ui({ type: "month", month: next })];
  }
  if (!m.month) return [info("Import a bank, card or Wealthsimple file first. Press i.")];
  if (input === "e") return [intent({ type: "explain", spaceId: m.spaceId, month: m.month })];
  const category = m.categories[u.money.row];
  if (!category) return [info("Pick a category with j or k first.")];
  return [ask("budget", category)];
}

// One command key, outside any overlay and the Ask box.
function globalKey(input: string, key: Key, u: Ui, view: View, ctx: KeyContext): Command[] {
  if (key.escape) return [ui({ type: "back" })];
  if (key.ctrl) {
    if (input === "d") return [ui({ type: "page", dir: 1 })];
    if (input === "u") return [ui({ type: "page", dir: -1 })];
    return [];
  }
  if (u.tab === "money") {
    const m = moneyKey(input, key, u, ctx);
    if (m) return m;
  }
  if (key.tab) return u.tab === "spaces" ? [ui({ type: "cycle", dir: key.shift ? -1 : 1 })] : [ui({ type: "move", delta: key.shift ? -1 : 1 })];
  if (key.leftArrow || key.rightArrow) return u.tab === "spaces" ? [ui({ type: "column", dir: key.leftArrow ? "left" : "right" })] : [];
  if (key.downArrow) return [ui({ type: "move", delta: 1 })];
  if (key.upArrow) return [ui({ type: "move", delta: -1 })];
  if (u.tab === "home") {
    const h = homeKey(input, key, u, view);
    if (h) return h;
  }
  if (key.return) {
    if (u.tab === "spaces" && u.focus === "detail" && view.subject === "task") return [transcript(u, view)];
    if (u.tab === "home") return [nothingHere(u, view, "Nothing needs you right now.")];
    return [ui({ type: "enter" })];
  }
  const onFile = fileKey(input, u, view, ctx.files);
  if (onFile) return onFile;
  const tab = "12345".indexOf(input);
  if (input && tab >= 0) return [ui({ type: "tab", tab: TABS[tab]! })];
  switch (input) {
    case " ":
    case ":":
      return [ask("ask")];
    case "j":
      return [ui({ type: "move", delta: 1 })];
    case "k":
      return [ui({ type: "move", delta: -1 })];
    case "g":
      return [ui({ type: "edge", to: "top" })];
    case "G":
      return [ui({ type: "edge", to: "bottom" })];
    case "?":
      return [open({ kind: "help" })];
    case "q":
      return [{ kind: "quit" }];
    case "u":
      return [open({ kind: "agents", scroll: 0 })];
    case "o":
      return [intent({ type: "overnight", on: !view.state.power.overnight })];
    case "/": {
      const pane = listPaneOf(u);
      if (!pane) return [info("Filter works in lists: Home, the spaces and tasks in Spaces, and Activity.")];
      return [ask("filter", pane, u.filters[pane])];
    }
    case ".":
      return [stop(u, view)];
    case "t":
      return [transcript(u, view)];
    case "a":
      return [approve(u, view)];
    case "r":
      return [sendBack(u, view)];
  }
  if (u.tab !== "spaces") return [];
  return spacesKey(input, u, view);
}

function spacesKey(input: string, u: Ui, view: View): Command[] {
  const space = spaceOf(u, view);
  const task = taskOf(u, view);
  if (space?.status === "archived" && ["n", "p", "e", "v"].includes(input)) return [info(`${space.name} is archived. Press X to restore it first.`)];
  switch (input) {
    case "h":
      return [ui({ type: "column", dir: "left" })];
    case "l":
      return [ui({ type: "column", dir: "right" })];
    case "R":
      if (!task) return [nothingHere(u, view, NO_TASK)];
      if (task.status !== "blocked" && task.status !== "failed") return [info("Retry is for blocked or failed tasks.")];
      return [intent({ type: "retry", taskId: task.id })];
    case "s":
      if (!task || waitOf(task, view.state)?.kind !== "reserve") return [info("Run now is for tasks waiting on Claude's reserve.")];
      return [intent({ type: "runNow", taskId: task.id })];
    case "n":
      if (!space) return [info(NO_SPACE)];
      return [ask("ask")];
    case "N":
      return [ask("space")];
    case "A":
      if (!task) return [nothingHere(u, view, NO_TASK)];
      if (task.status !== "queued") return [info("This task has already started, so its agent can't change.")];
      if (task.kind !== "work") return [info("Reviews and fixes use the agent the space picked.")];
      return [open({ kind: "picker", purpose: "agent", targetId: task.id, options: [...AGENT_CHOICES], index: Math.max(0, AGENT_CHOICES.indexOf(task.agent as AgentChoice)) })];
    case "p":
      if (!space) return [info(NO_SPACE)];
      return [intent({ type: "private", spaceId: space.id, on: !space.private })];
    case "e":
      if (!space) return [info(NO_SPACE)];
      return [ask("goal", space.id, space.goal)];
    case "v":
      if (!space) return [info(NO_SPACE)];
      // Reviews read the branch diff, so only repo spaces have anything to review.
      if (space.kind !== "repo") return [info("Reviews are for repo spaces.")];
      return [open({ kind: "picker", purpose: "reviewer", targetId: space.id, options: REVIEWER_OPTIONS, index: Math.max(0, REVIEWER_OPTIONS.indexOf(space.reviewBy ?? "none")) })];
    case "X":
      if (!space) return [info(NO_SPACE)];
      // Restoring is undone by archiving again, so it needs no confirm.
      if (space.status === "archived") return [intent({ type: "restore", spaceId: space.id })];
      return [open({ kind: "confirm", purpose: "archive", targetId: space.id })];
    case "D":
      if (!space) return [info(NO_SPACE)];
      return [open({ kind: "delete", spaceId: space.id, value: "", cursor: 0 })];
    default:
      return [];
  }
}

// The new-task box on Spaces cycles its agent with tab; nothing else does.
export function askAgentCycles(u: Ui, view: View): boolean {
  return u.ask?.purpose === "ask" && u.tab === "spaces" && !!spaceOf(u, view) && spaceOf(u, view)!.status !== "archived";
}

// What the Ask box sends on enter, by what it's for and the tab it's on.
function submitAsk(a: Ask, u: Ui, view: View, ctx: KeyContext): Command[] {
  const text = a.value.trim();
  const target = a.targetId ?? "";
  const empty = info("Type something first, or press esc to cancel.");
  switch (a.purpose) {
    case "filter":
      return [leaveAsk];
    case "reply":
      // The server accepts a send-back with no note.
      return [intent({ type: "reject", approvalId: target, note: a.value }), leaveAsk];
    case "goal":
      if (!text) return [info("A goal can't be empty. Describe what this space is for.")];
      return [intent({ type: "goal", spaceId: target, goal: text }), leaveAsk];
    case "budget": {
      if (!ctx.money) return [leaveAsk, info(NO_INVESTING)];
      const n = Number(text.replace(/[$,\s]|CA\$/gi, ""));
      if (text && (!Number.isFinite(n) || n < 0)) return [info("Type an amount like 400, or leave it empty for no budget.")];
      return [intent({ type: "budget", spaceId: ctx.money.spaceId, category: target, limit: !text || n === 0 ? null : n }), leaveAsk];
    }
    case "import":
      if (!text) return [info("Type the path to a CSV file, or drag the file into the terminal.")];
      return [intent({ type: "importPreview", spaceId: target, path: text }), leaveAsk];
    case "space":
      if (!text) return [empty];
      return [intent({ type: "newSpace", text }), leaveAsk];
    case "ask": {
      if (!text) return [empty];
      if (u.tab === "money") {
        if (!ctx.money) return [leaveAsk, info(NO_INVESTING)];
        return [intent({ type: "moneyAsk", spaceId: ctx.money.spaceId, question: text }), leaveAsk];
      }
      if (u.tab === "investing") {
        if (!ctx.invest) return [leaveAsk, info(NO_INVESTING)];
        const key = ctx.invest.keys[u.invest.row];
        if (key) return [intent({ type: "investAsk", spaceId: ctx.invest.spaceId, key, question: text }), leaveAsk];
        return [intent({ type: "newTask", spaceId: ctx.invest.spaceId, text, agent: "auto" }), leaveAsk];
      }
      const space = spaceOf(u, view);
      if (u.tab === "spaces" && space && space.status !== "archived") return [intent({ type: "newTask", spaceId: space.id, text, agent: a.agent }), leaveAsk];
      return [intent({ type: "newSpace", text }), leaveAsk];
    }
  }
}

function askKey(input: string, key: Key, a: Ask, u: Ui, view: View, ctx: KeyContext): Command[] {
  if (key.tab) {
    if (!askAgentCycles(u, view)) return [];
    const next = AGENT_CHOICES[(AGENT_CHOICES.indexOf(a.agent) + 1) % AGENT_CHOICES.length]!;
    return [ui({ type: "ask", ask: { ...a, agent: next } })];
  }
  const filterPane = a.purpose === "filter" ? (a.targetId as ListPane) : null;
  const result = editLine(a, input, key);
  if (result === "cancel") return filterPane ? [ui({ type: "filter", pane: filterPane, text: "" }), leaveAsk] : [leaveAsk];
  if (result === "submit") return submitAsk(a, u, view, ctx);
  const next = ui({ type: "ask", ask: { ...a, ...result } });
  return filterPane ? [next, ui({ type: "filter", pane: filterPane, text: result.value })] : [next];
}

function deleteKey(input: string, key: Key, overlay: Extract<Overlay, { kind: "delete" }>, view: View): Command[] {
  const result = editLine(overlay, input, key);
  if (result === "cancel") return [close];
  if (result === "submit") {
    const space = [...view.state.spaces, ...(view.state.archived ?? [])].find((s) => s.id === overlay.spaceId);
    if (!space) return [close, info("That space isn't here anymore.")];
    if (!nameMatches(overlay.value, space.name)) return [info(`Type "${space.name}" exactly to delete it, or press esc to keep it.`)];
    return [intent({ type: "deleteSpace", spaceId: space.id, name: overlay.value }), close];
  }
  return [ui({ type: "setOverlay", overlay: { ...overlay, ...result } })];
}

function pickerKey(input: string, key: Key, overlay: Extract<Overlay, { kind: "picker" }>): Command[] {
  const move = (delta: number) => [ui({ type: "setOverlay", overlay: { ...overlay, index: (overlay.index + delta + overlay.options.length) % overlay.options.length } })];
  if (key.escape || input === "q") return [close];
  if (key.downArrow || input === "j") return move(1);
  if (key.upArrow || input === "k") return move(-1);
  if (!key.return) return [];
  const choice = overlay.options[overlay.index]!;
  if (overlay.purpose === "agent") return [intent({ type: "setAgent", taskId: overlay.targetId, agent: choice as AgentChoice }), close];
  return [intent({ type: "reviewer", spaceId: overlay.targetId, reviewBy: choice === "none" ? null : (choice as ReviewerId) }), close];
}

const RESERVE_STEPS = [0.25, 0.5, 0.75] as const;
// Half a screen of transcript; the App clamps the result to what the view holds.
const PAGE = 10;
const BOTTOM = Number.MAX_SAFE_INTEGER;

// j/k/g/G and half pages, shared by the full-screen views. Null when the key isn't a scroll key.
function scrollKey(input: string, key: Key, scroll: number): number | null {
  if (key.ctrl) return input === "d" ? scroll + PAGE : input === "u" ? Math.max(0, scroll - PAGE) : null;
  if (key.downArrow || input === "j") return scroll + 1;
  if (key.upArrow || input === "k") return Math.max(0, scroll - 1);
  if (input === "g") return 0;
  if (input === "G") return BOTTOM;
  return null;
}

function transcriptKey(input: string, key: Key, overlay: Extract<Overlay, { kind: "transcript" }>, view: View): Command[] {
  if (input === "q" || key.escape) return [close];
  const runs = view.state.runs.filter((r) => r.taskId === overlay.taskId).length;
  // Runs are listed newest first, so older is further along.
  if (input === "[" || input === "]") {
    const runIndex = Math.min(runs - 1, Math.max(0, overlay.runIndex + (input === "[" ? 1 : -1)));
    if (runIndex === overlay.runIndex) return [info(input === "[" ? "This is the oldest run." : "This is the newest run.")];
    return [ui({ type: "setOverlay", overlay: { ...overlay, runIndex, scroll: 0 } })];
  }
  const scroll = scrollKey(input, key, overlay.scroll);
  return scroll === null ? [] : [ui({ type: "setOverlay", overlay: { ...overlay, scroll } })];
}

function agentsKey(input: string, key: Key, overlay: Extract<Overlay, { kind: "agents" }>, view: View): Command[] {
  if (input === "u" || input === "q" || key.escape) return [close];
  if (input === "o") return [intent({ type: "overnight", on: !view.state.power.overnight })];
  if (input === "[" || input === "]") {
    const at = RESERVE_STEPS.findIndex((s) => s === view.state.usage.claudeReserve);
    const next = RESERVE_STEPS[(at < 0 ? 1 : at) + (input === "]" ? 1 : -1)];
    if (next === undefined) return [info(input === "]" ? "75% is the highest pause point." : "25% is the lowest pause point.")];
    return [intent({ type: "reserve", value: next })];
  }
  const scroll = scrollKey(input, key, overlay.scroll);
  return scroll === null ? [] : [ui({ type: "setOverlay", overlay: { ...overlay, scroll } })];
}

function detailKey(input: string, key: Key, overlay: Extract<Overlay, { kind: "detail" }>, u: Ui, view: View): Command[] {
  if (input === "q" || key.escape || key.return) return [close];
  // The card's own keys still work from its full text.
  if (["a", "r", "s", "x", "y", "n", "N", "t"].includes(input)) {
    const out = input === "a" ? [approve(u, view)] : input === "r" ? [sendBack(u, view)] : input === "t" ? [transcript(u, view)] : (homeKey(input, key, u, view) ?? []);
    return [close, ...out];
  }
  const scroll = scrollKey(input, key, overlay.scroll);
  return scroll === null ? [] : [ui({ type: "setOverlay", overlay: { ...overlay, scroll } })];
}

function confirmed(overlay: Extract<Overlay, { kind: "confirm" }>, view: View): Command[] {
  switch (overlay.purpose) {
    case "archive":
      return [intent({ type: "archive", spaceId: overlay.targetId })];
    case "stop":
      return [intent({ type: "stop", taskId: overlay.targetId })];
    case "import":
      return [intent({ type: "importCsv", spaceId: overlay.targetId, csv: overlay.csv, account: overlay.account })];
    case "accept": {
      const approval = view.state.approvals.find((a) => a.id === overlay.targetId);
      return approval ? [intent({ type: "approve", approvalId: approval.id, title: approval.title })] : [info("Already handled. It was decided somewhere else.")];
    }
  }
}

function overlayKey(input: string, key: Key, overlay: Overlay, u: Ui, view: View): Command[] {
  switch (overlay.kind) {
    case "picker":
      return pickerKey(input, key, overlay);
    case "delete":
      return deleteKey(input, key, overlay, view);
    case "confirm":
      if (input === "y") return [close, ...confirmed(overlay, view)];
      return input === "n" || input === "q" || key.escape ? [close] : [];
    case "help":
      return input === "?" || input === "q" || key.escape ? [close] : [];
    case "agents":
      return agentsKey(input, key, overlay, view);
    case "transcript":
      return transcriptKey(input, key, overlay, view);
    case "detail":
      return detailKey(input, key, overlay, u, view);
  }
}

export function commandsFor(input: string, key: Key, u: Ui, view: View, ctx: KeyContext = NO_CONTEXT): Command[] {
  const clear: Command[] = u.flash ? [ui({ type: "flash", flash: null })] : [];
  // Inside the Ask box or the delete box the whole chunk is text, so a paste lands whole and never runs as commands.
  if (u.overlay?.kind === "delete") return [...clear, ...deleteKey(input, key, u.overlay, view)];
  if (u.ask && !u.overlay) return [...clear, ...askKey(input, key, u.ask, u, view, ctx)];
  // Keys typed quickly arrive as one chunk; each character is its own command.
  const chars = input.length > 1 && !key.ctrl && !key.meta ? [...input] : [input];
  const out = [...clear];
  for (const ch of chars) out.push(...(u.overlay ? overlayKey(ch, key, u.overlay, u, view) : globalKey(ch, key, u, view, ctx)));
  return out;
}
