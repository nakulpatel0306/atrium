// What the command palette (⌘K) can do, by name: every action in the dashboard, built from the state it's opened on.
// Pure, so the list and its matching are tested without a page.
import { batchApprovable } from "../engine/needs";
import { SHAPE_LABEL, suggestion, switchOpen } from "../engine/shape";
import type { State } from "../engine/state";
import { attentionQueue, cleanReviews, itemLabel, itemTitle, shownSha, taskTag } from "./queue";
import { shownTitle } from "./summary";

type PaletteGroup = "Do" | "Go to" | "Spaces" | "Tasks" | "Needs you" | "Settings";

// `run` names what the page does on Enter, so the component stays one switch and a test can read the intent.
type PaletteRun =
  | { kind: "navigate"; path: string }
  | { kind: "ask" }
  | { kind: "newSpace" }
  | { kind: "post"; path: string; body?: unknown; done: string; undo?: string }
  | { kind: "patch"; path: string; body: unknown; done: string }
  | { kind: "theme"; theme: Theme };

export type PaletteAction = { id: string; group: PaletteGroup; label: string; hint?: string; run: PaletteRun };
export type Theme = "system" | "light" | "dark";

const LEARNING_TEXT = { off: "Off", light: "Light", deep: "Deep" } as const;

export function paletteActions(state: State, here: { spaceId: string | null; theme: Theme }): PaletteAction[] {
  const actions: PaletteAction[] = [];
  const here_ = here.spaceId ? state.spaces.find((s) => s.id === here.spaceId) : undefined;
  actions.push({ id: "ask", group: "Do", label: here_ ? `New task in ${here_.name}` : "New task or space", hint: "/", run: { kind: "ask" } });
  actions.push({ id: "new-space", group: "Do", label: "New space", run: { kind: "newSpace" } });

  // Built once: every Needs you action and every task's tag reads it.
  const queue = attentionQueue(state);
  const clean = cleanReviews(state, queue);
  // Opens the same list the queue shows, so a batch is always approved after one look at what's in it.
  if (clean.length >= 2) actions.push({ id: "approve-clean", group: "Needs you", label: `Approve ${clean.length} clean results`, hint: "Shows the list first", run: { kind: "navigate", path: "/needs-you?batch=1" } });
  for (const item of queue) {
    const title = itemTitle(state, item);
    actions.push({ id: `open-${item.key}`, group: "Needs you", label: `Open ${title}`, hint: itemLabel(state, item), run: { kind: "navigate", path: `/needs-you?item=${encodeURIComponent(item.key)}` } });
    const a = item.kind === "review" ? state.approvals.find((x) => x.id === item.key) : undefined;
    // Only a clean result is approvable by name; anything else opens to be read first.
    if (a && batchApprovable(a, state.tasks.find((t) => t.id === a.taskId))) {
      const sha = shownSha(state, a);
      actions.push({ id: `approve-${a.id}`, group: "Needs you", label: `Approve ${title}`, run: { kind: "post", path: `/api/approvals/${a.id}`, body: { decision: "approve", ...(sha ? { sha } : {}) }, done: `Approved: ${title}`, undo: a.id } });
    }
  }

  const pages: [string, string][] = [["/", "Home"], ["/needs-you", "Needs you"], ["/activity", "Activity"], ["/agents", "Agents"], ["/rules", "Rules"], ["/settings", "Settings"], ["/start", "Get started"]];
  for (const [path, label] of pages) actions.push({ id: `go-${path}`, group: "Go to", label, run: { kind: "navigate", path } });

  for (const s of state.spaces) {
    actions.push({ id: `space-${s.id}`, group: "Spaces", label: s.name, hint: s.kind === "repo" ? "Code space" : "Space", run: { kind: "navigate", path: `/space/${s.id}` } });
    if (s.kind === "repo") {
      for (const level of ["off", "light", "deep"] as const) {
        if (level === s.learning) continue;
        actions.push({ id: `learning-${s.id}-${level}`, group: "Settings", label: `Learning in ${s.name}: ${LEARNING_TEXT[level]}`, hint: `now ${LEARNING_TEXT[s.learning]}`, run: { kind: "patch", path: `/api/spaces/${s.id}`, body: { learning: level }, done: `Learning in ${s.name} is ${LEARNING_TEXT[level]}.` } });
      }
    }
  }

  // Open work first, then the most recent of the rest, so a jump finds what's live.
  const open = state.tasks.filter((t) => t.status !== "done");
  const done = state.tasks.filter((t) => t.status === "done").sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50);
  for (const t of [...open, ...done]) {
    const space = state.spaces.find((s) => s.id === t.spaceId);
    if (!space) continue;
    actions.push({ id: `task-${t.id}`, group: "Tasks", label: shownTitle(t), hint: `${space.name} · ${taskTag(state, t, queue)}`, run: { kind: "navigate", path: `/space/${space.id}?task=${t.id}` } });
    const shape = t.loop?.shape;
    const offer = shape && switchOpen(t) ? suggestion(shape, t.brief?.size ?? "medium") : null;
    if (offer) actions.push({ id: `shape-${t.id}`, group: "Tasks", label: `Run ${shownTitle(t)} as ${SHAPE_LABEL[offer].toLowerCase()}`, hint: "Starts over from the brief", run: { kind: "post", path: `/api/tasks/${t.id}/shape`, body: { kind: offer }, done: `Starting ${shownTitle(t)} over as ${SHAPE_LABEL[offer].toLowerCase()}.` } });
  }

  for (const theme of ["system", "light", "dark"] as const) {
    if (theme !== here.theme) actions.push({ id: `theme-${theme}`, group: "Settings", label: `Theme: ${theme === "system" ? "match the Mac" : theme}`, run: { kind: "theme", theme } });
  }
  return actions;
}

// Every typed word must appear in the label or hint, in any order; earlier and word-start matches rank higher.
export function matchActions(actions: PaletteAction[], query: string): PaletteAction[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return actions;
  const scored: { a: PaletteAction; score: number }[] = [];
  for (const a of actions) {
    const label = a.label.toLowerCase();
    const hay = `${label} ${a.hint?.toLowerCase() ?? ""}`;
    let score = 0;
    let ok = true;
    for (const w of words) {
      const at = hay.indexOf(w);
      if (at < 0) {
        ok = false;
        break;
      }
      score += at + (at === 0 || hay[at - 1] === " " ? 0 : 20) + (at >= label.length ? 40 : 0);
    }
    if (ok) scored.push({ a, score });
  }
  // Stable, so equal scores keep the list's own order.
  return scored.sort((x, y) => x.score - y.score).map((x) => x.a);
}
