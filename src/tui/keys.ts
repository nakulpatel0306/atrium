// What every key does, as a pure function of the key, the UI state, and what's on screen.
import type { Key } from "ink";
import { AGENT_CHOICES, type AgentChoice, waitOf } from "../dashboard/agents";
import type { ReviewerId } from "../engine/spaces";
import { editLine } from "./edit";
import { listOf, pick, type View } from "./select";
import type { Action, ListPane, Overlay, Pane, Ui } from "./ui";

export type Intent =
  | { type: "approve"; approvalId: string; title: string }
  | { type: "reject"; approvalId: string; note: string }
  | { type: "retry"; taskId: string }
  | { type: "runNow"; taskId: string }
  | { type: "newTask"; spaceId: string; text: string; agent: AgentChoice }
  | { type: "newSpace"; text: string }
  | { type: "setAgent"; taskId: string; agent: AgentChoice }
  | { type: "overnight"; on: boolean }
  | { type: "reserve"; value: 0.25 | 0.5 | 0.75 }
  | { type: "private"; spaceId: string; on: boolean }
  | { type: "goal"; spaceId: string; goal: string }
  | { type: "reviewer"; spaceId: string; reviewBy: ReviewerId | null }
  | { type: "archive"; spaceId: string }
  | { type: "answer"; proposalId: string; answer: "yes" | "not_now" | "never"; label: string };

export type Command = { kind: "ui"; action: Action } | { kind: "intent"; intent: Intent } | { kind: "quit" };

type Section = "Move" | "Act" | "Space" | "Views";

export const HELP: { section: Section; keys: string; does: string }[] = [
  { section: "Move", keys: "1 2 3 4", does: "focus a left pane" },
  { section: "Move", keys: "0 5", does: "detail, live" },
  { section: "Move", keys: "tab", does: "next pane, S-tab back" },
  { section: "Move", keys: "h l", does: "left / right column" },
  { section: "Move", keys: "j k", does: "down / up, or scroll" },
  { section: "Move", keys: "g G", does: "top / bottom, follow" },
  { section: "Move", keys: "ctrl-d ctrl-u", does: "half page down / up" },
  { section: "Move", keys: "enter", does: "open" },
  { section: "Move", keys: "esc", does: "back / clear filter" },
  { section: "Move", keys: "/", does: "filter" },
  { section: "Act", keys: "a", does: "approve" },
  { section: "Act", keys: "r", does: "send back" },
  { section: "Act", keys: "R", does: "retry" },
  { section: "Act", keys: "s", does: "run now" },
  { section: "Act", keys: "n", does: "new task" },
  { section: "Act", keys: "N", does: "new space" },
  { section: "Act", keys: "A", does: "change agent" },
  { section: "Act", keys: "y n N", does: "suggestion: yes/later/never" },
  { section: "Space", keys: "p", does: "private on / off" },
  { section: "Space", keys: "e", does: "edit goal" },
  { section: "Space", keys: "v", does: "pick reviewer" },
  { section: "Space", keys: "X", does: "archive space" },
  { section: "Views", keys: "t", does: "transcript" },
  { section: "Views", keys: "u", does: "agents and usage" },
  { section: "Views", keys: "o", does: "overnight mode" },
  { section: "Views", keys: "?", does: "help" },
  { section: "Views", keys: "q", does: "close, or quit" },
  { section: "Views", keys: "[ ]", does: "run or pause point" },
  { section: "Views", keys: "y", does: "yes, when asked" },
];

const HINT_KEYS: Record<Pane, string[]> = {
  spaces: ["enter", "n", "N", "p", "e", "X"],
  tasks: ["enter", "n", "R", "s", "A", "t"],
  needs: ["a", "r", "enter", "t"],
  activity: ["enter", "/"],
  detail: ["j k", "a", "r", "t"],
  live: ["j k", "g G"],
};

// The status bar's reminder of what the focused pane's keys do.
const OVERLAY_HINTS: Partial<Record<Overlay["kind"], string>> = {
  transcript: "j k scroll  g G top / bottom  [ ] older / newer run  q close",
  agents: "[ ] pause point  o overnight mode  j k scroll  q close",
  help: "? or q close",
};

export function hints(ui: Ui, view: View): string {
  const overlay = ui.overlay && OVERLAY_HINTS[ui.overlay.kind];
  if (overlay) return ui.overlay?.kind === "help" ? overlay : `? help  ${overlay}`;
  const keys = ["?", ...HINT_KEYS[ui.focus]].map((k) => `${k} ${HELP.find((h) => h.keys === k)?.does ?? ""}`);
  const pane = ui.focus === "detail" || ui.focus === "live" ? null : ui.focus;
  const list = pane ? listOf(view, pane) : [];
  if (pane && list.length > 0 && !pick(list, ui.selected[pane]).item) keys.unshift("j k select an item");
  if (pane === "needs" && pinnedSuggestion(ui, view)) return ["? help", "y yes", "n not now", "N never", "enter open"].join("  ");
  return keys.join("  ");
}

const REVIEWER_OPTIONS = ["none", "codex", "gemini", "claude"];
const NO_SPACE = "Pick a space first, or press N to describe a new one.";
const NO_TASK = "Pick a task in Tasks [2] first.";

const ui = (action: Action): Command => ({ kind: "ui", action });
const intent = (i: Intent): Command => ({ kind: "intent", intent: i });
const info = (text: string): Command => ui({ type: "flash", flash: { tone: "info", text } });
const open = (overlay: Overlay): Command => ui({ type: "open", overlay });
const close: Command = ui({ type: "close" });

const isList = (p: Pane): p is ListPane => p !== "detail" && p !== "live";
// Detail and Live act on whatever the left column last selected.
const leftOf = (u: Ui): ListPane => (isList(u.focus) ? u.focus : u.lastLeft);

const pinnedSuggestion = (u: Ui, view: View) => view.proposal && u.selected.needs.id === view.proposal.id;

// Actions act only on a row pinned by id, never on whatever happens to sit at the cursor's position.
const pinned = <T extends { id: string }>(u: Ui, pane: ListPane, item: T | null): T | null =>
  item && u.selected[pane].id === item.id ? item : null;

function approvalOf(u: Ui, view: View) {
  const pane = leftOf(u);
  if (pane === "needs") return pinned(u, "needs", view.approval);
  const task = pane === "tasks" ? pinned(u, "tasks", view.task) : null;
  return task?.approvalId ? (view.state.approvals.find((a) => a.id === task.approvalId) ?? null) : null;
}

function proposalOf(u: Ui, view: View) {
  return leftOf(u) === "needs" ? pinned(u, "needs", view.proposal) : null;
}

const ANSWERS = { y: "yes", n: "not_now", N: "never" } as const;

function taskOf(u: Ui, view: View) {
  const pane = leftOf(u);
  if (pane === "tasks") return pinned(u, "tasks", view.task);
  const approval = pane === "needs" ? pinned(u, "needs", view.approval) : null;
  return approval?.taskId ? (view.state.tasks.find((t) => t.id === approval.taskId) ?? null) : null;
}

// Why a key found nothing to act on: an empty pane, or rows with none picked.
function nothingHere(u: Ui, view: View, empty: string): Command {
  const pane = leftOf(u);
  if (listOf(view, pane).length > 0 && !pick(listOf(view, pane), u.selected[pane]).item) {
    return info("Select an item first: press j or k.");
  }
  return info(empty);
}

function transcript(u: Ui, view: View): Command {
  const task = taskOf(u, view);
  if (!task) return nothingHere(u, view, NO_TASK);
  if (!view.state.runs.some((r) => r.taskId === task.id)) return info("No runs yet.");
  return open({ kind: "transcript", taskId: task.id, runIndex: 0, scroll: 0 });
}

function prompt(purpose: "task" | "space" | "reply" | "goal" | "filter", targetId: string | null, value = ""): Command {
  return open({ kind: "prompt", purpose, value, cursor: value.length, agent: "auto", targetId });
}

// One command key, outside any overlay.
function globalKey(input: string, key: Key, u: Ui, view: View): Command[] {
  if (key.tab) return [ui({ type: "cycle", dir: key.shift ? -1 : 1 })];
  if (key.leftArrow) return [ui({ type: "column", dir: "left" })];
  if (key.rightArrow) return [ui({ type: "column", dir: "right" })];
  if (key.downArrow) return [ui({ type: "move", delta: 1 })];
  if (key.upArrow) return [ui({ type: "move", delta: -1 })];
  if (key.escape) return [ui({ type: "back" })];
  if (key.return) {
    if (u.focus === "detail" && view.subject === "task") return [transcript(u, view)];
    return [ui({ type: "enter" })];
  }
  if (key.ctrl) {
    if (input === "d") return [ui({ type: "page", dir: 1 })];
    if (input === "u") return [ui({ type: "page", dir: -1 })];
    return [];
  }
  const space = pinned(u, "spaces", view.space);
  const task = taskOf(u, view);
  // On a suggestion in Needs you, y / n / N answer it; everywhere else n and N make a task and a space.
  const suggestion = proposalOf(u, view);
  if (suggestion) {
    if (input === "y" || input === "n" || input === "N") {
      return [intent({ type: "answer", proposalId: suggestion.id, answer: ANSWERS[input], label: suggestion.label })];
    }
    if (input === "a" || input === "r") return [info("That's a suggestion: y yes, n not now, N never.")];
  }
  switch (input) {
    case "1":
      return [ui({ type: "focus", pane: "spaces" })];
    case "2":
      return [ui({ type: "focus", pane: "tasks" })];
    case "3":
      return [ui({ type: "focus", pane: "needs" })];
    case "4":
      return [ui({ type: "focus", pane: "activity" })];
    case "0":
      return [ui({ type: "focus", pane: "detail" })];
    case "5":
      return [ui({ type: "focus", pane: "live" })];
    case "h":
      return [ui({ type: "column", dir: "left" })];
    case "l":
      return [ui({ type: "column", dir: "right" })];
    case "j":
      return [ui({ type: "move", delta: 1 })];
    case "k":
      return [ui({ type: "move", delta: -1 })];
    case "g":
      return [ui({ type: "edge", to: "top" })];
    case "G":
      return [ui({ type: "edge", to: "bottom" })];
    case "/":
      if (!isList(u.focus)) return [info("Filter works in the list panes, [1] to [4].")];
      return [prompt("filter", u.focus, u.filters[u.focus])];
    case "?":
      return [open({ kind: "help" })];
    case "q":
      return [{ kind: "quit" }];
    case "u":
      return [open({ kind: "agents", scroll: 0 })];
    case "o":
      return [intent({ type: "overnight", on: !view.state.power.overnight })];
    case "t":
      return [transcript(u, view)];
    case "a": {
      const approval = approvalOf(u, view);
      if (!approval) return [nothingHere(u, view, "Nothing to approve here. Pick a row in Needs you [3].")];
      return [intent({ type: "approve", approvalId: approval.id, title: approval.title })];
    }
    case "r": {
      const approval = approvalOf(u, view);
      if (!approval) return [nothingHere(u, view, "Nothing to send back here. Pick a row in Needs you [3].")];
      return [prompt("reply", approval.id)];
    }
    case "R":
      if (!task) return [nothingHere(u, view, NO_TASK)];
      if (task.status !== "blocked" && task.status !== "failed") return [info("Retry is for blocked or failed tasks.")];
      return [intent({ type: "retry", taskId: task.id })];
    case "s":
      if (!task || waitOf(task, view.state)?.kind !== "reserve") {
        return [info("Run now is for tasks waiting on Claude's reserve.")];
      }
      return [intent({ type: "runNow", taskId: task.id })];
    case "n":
      if (!space) return [info(NO_SPACE)];
      return [prompt("task", space.id)];
    case "N":
      return [prompt("space", null)];
    case "A":
      if (!task) return [nothingHere(u, view, NO_TASK)];
      if (task.status !== "queued") return [info("This task has already started, so its agent can't change.")];
      if (task.kind !== "work") return [info("Reviews and fixes use the agent the space picked.")];
      return [
        open({
          kind: "picker",
          purpose: "agent",
          targetId: task.id,
          options: [...AGENT_CHOICES],
          index: Math.max(0, AGENT_CHOICES.indexOf(task.agent as AgentChoice)),
        }),
      ];
    case "p":
      if (!space) return [info(NO_SPACE)];
      return [intent({ type: "private", spaceId: space.id, on: !space.private })];
    case "e":
      if (!space) return [info(NO_SPACE)];
      return [prompt("goal", space.id, space.goal)];
    case "v":
      if (!space) return [info(NO_SPACE)];
      // Reviews read the branch diff, so only repo spaces have anything to review.
      if (space.kind !== "repo") return [info("Reviews are for repo spaces.")];
      return [
        open({
          kind: "picker",
          purpose: "reviewer",
          targetId: space.id,
          options: REVIEWER_OPTIONS,
          index: Math.max(0, REVIEWER_OPTIONS.indexOf(space.reviewBy ?? "none")),
        }),
      ];
    case "X":
      if (!space) return [info(NO_SPACE)];
      return [open({ kind: "confirm", purpose: "archive", targetId: space.id })];
    default:
      return [];
  }
}

function promptKey(input: string, key: Key, overlay: Extract<Overlay, { kind: "prompt" }>): Command[] {
  if (key.tab && overlay.purpose === "task") {
    const next = AGENT_CHOICES[(AGENT_CHOICES.indexOf(overlay.agent) + 1) % AGENT_CHOICES.length]!;
    return [ui({ type: "setOverlay", overlay: { ...overlay, agent: next } })];
  }
  const filterPane = overlay.purpose === "filter" ? (overlay.targetId as ListPane) : null;
  const result = editLine(overlay, input, key);
  if (result === "cancel") {
    return filterPane ? [ui({ type: "filter", pane: filterPane, text: "" }), close] : [close];
  }
  if (result === "submit") {
    const text = overlay.value.trim();
    const target = overlay.targetId ?? "";
    switch (overlay.purpose) {
      case "filter":
        return [close];
      case "reply":
        // The server accepts a send-back with no note.
        return [intent({ type: "reject", approvalId: target, note: overlay.value }), close];
      case "goal":
        if (!text) return [info("A goal can't be empty. Describe what this space is for.")];
        return [intent({ type: "goal", spaceId: target, goal: text }), close];
      case "task":
        if (!text) return [info("Type something first, or press esc to cancel.")];
        return [intent({ type: "newTask", spaceId: target, text, agent: overlay.agent }), close];
      case "space":
        if (!text) return [info("Type something first, or press esc to cancel.")];
        return [intent({ type: "newSpace", text }), close];
    }
  }
  const next = ui({ type: "setOverlay", overlay: { ...overlay, ...result } });
  return filterPane ? [next, ui({ type: "filter", pane: filterPane, text: result.value })] : [next];
}

function pickerKey(input: string, key: Key, overlay: Extract<Overlay, { kind: "picker" }>): Command[] {
  const move = (delta: number) => {
    const index = (overlay.index + delta + overlay.options.length) % overlay.options.length;
    return [ui({ type: "setOverlay", overlay: { ...overlay, index } })];
  };
  if (key.escape || input === "q") return [close];
  if (key.downArrow || input === "j") return move(1);
  if (key.upArrow || input === "k") return move(-1);
  if (!key.return) return [];
  const choice = overlay.options[overlay.index]!;
  if (overlay.purpose === "agent") {
    return [intent({ type: "setAgent", taskId: overlay.targetId, agent: choice as AgentChoice }), close];
  }
  const reviewBy = choice === "none" ? null : (choice as ReviewerId);
  return [intent({ type: "reviewer", spaceId: overlay.targetId, reviewBy }), close];
}

const RESERVE_STEPS = [0.25, 0.5, 0.75] as const;
// Half a screen of transcript; the App clamps the result to what the transcript holds.
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

function overlayKey(input: string, key: Key, overlay: Overlay, view: View): Command[] {
  switch (overlay.kind) {
    case "prompt":
      return promptKey(input, key, overlay);
    case "picker":
      return pickerKey(input, key, overlay);
    case "confirm":
      if (input === "y") return [intent({ type: "archive", spaceId: overlay.targetId }), close];
      return input === "n" || input === "q" || key.escape ? [close] : [];
    case "help":
      return input === "?" || input === "q" || key.escape ? [close] : [];
    case "agents":
      return agentsKey(input, key, overlay, view);
    case "transcript":
      return transcriptKey(input, key, overlay, view);
  }
}

export function commandsFor(input: string, key: Key, u: Ui, view: View): Command[] {
  const clear: Command[] = u.flash ? [ui({ type: "flash", flash: null })] : [];
  // Inside a prompt the whole chunk is text, so a paste lands whole and never runs as commands.
  if (u.overlay?.kind === "prompt") return [...clear, ...promptKey(input, key, u.overlay)];
  // Keys typed quickly arrive as one chunk; each character is its own command.
  const chars = input.length > 1 && !key.ctrl && !key.meta ? [...input] : [input];
  const out = [...clear];
  for (const ch of chars) out.push(...(u.overlay ? overlayKey(ch, key, u.overlay, view) : globalKey(ch, key, u, view)));
  return out;
}
