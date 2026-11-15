// Home: the briefing, Needs you as cards with their actions on them, and what's running beside them (below them under
// 100 columns).
import { agentText } from "../../dashboard/agents";
import { askLine } from "../../engine/needs";
import { KIND } from "../../engine/words";
import { askSteps } from "../keys";
import { duration, relative } from "../../dashboard/format";
import { liveStatus, reviewLine } from "../../dashboard/summary";
import { outcomeText } from "../../engine/outcome";
import { type Block, box, columns, fit, type Hit, keyRow, label, type Line, rowsOf, shift } from "../canvas";
import { wrapStyled } from "../detail";
import type { View } from "../select";
import { oneLine } from "../text";
import { GLYPH, SPINNER, spaceTone, type Tone } from "../theme";
import type { Ui } from "../ui";

export type HomeData = {
  // The last line the first running task's agent wrote.
  lastLine: string;
  frame: number;
  now: number;
  // The briefing from when the app opened, as on the dashboard; the live tail after it is recomputed.
  briefing: View["state"]["briefing"];
};

type CardKey = { key: string; label: string; input: string; hot?: boolean };
type Card = { id: string; glyph: string; tone: Tone; title: string; meta: Line; body: Line[]; keys: CardKey[] };

const RIGHT = 36;

export function cardsOf(view: View, now: number, inner: number): Card[] {
  const { state } = view;
  const names = new Map(state.spaces.map((s, i) => [s.id, { name: s.name, i }]));
  const owner = (spaceId: string | null): Line => {
    if (spaceId === null) return [{ text: "Atrium", color: "info" }];
    const s = names.get(spaceId);
    return [{ text: s?.name ?? "Unknown space", color: s ? spaceTone(s.i) : "faint" }];
  };
  const dot = { text: "  ·  ", color: "faint" } as const;
  const open: CardKey = { key: "↵", label: "Read", input: "\r" };
  const cards: Card[] = [];
  // In the queue's order: longest-blocked first, low-priority items last.
  for (const item of view.queue) {
    if (item.kind === "question" || item.kind === "pick" || item.kind === "stuck") {
      const t = state.tasks.find((x) => x.id === item.key)!;
      const questions = t.loop!.questions;
      cards.push({
        id: t.id,
        glyph: "?",
        tone: "info",
        title: t.title,
        meta: [...owner(t.spaceId), dot, { text: `${KIND[item.kind].label} · ${relative(t.updatedAt, now)}`, color: "faint" }],
        body: wrapStyled([{ text: oneLine(questions.length ? questions.map((q) => q.question).join("  ") : askLine(t)), color: "dim" }], inner).slice(0, 2),
        // A question is answered right here; a pick or a stopped part is decided on its own screen, under the same name.
        keys: askSteps(t).length
          ? [{ key: "a", label: KIND.question.action, input: "a", hot: true }, { key: "↵", label: "Open", input: "\r" }]
          : [{ key: "↵", label: KIND[item.kind].action, input: "\r", hot: true }],
      });
      continue;
    }
    if (item.kind === "paused" || item.kind === "shape") {
      const t = state.tasks.find((x) => x.id === item.key)!;
      const paused = item.kind === "paused";
      cards.push({
        id: t.id,
        glyph: paused ? GLYPH.notdone : GLYPH.suggestion,
        tone: paused ? "bad" : "info",
        title: t.title,
        meta: [...owner(t.spaceId), dot, { text: paused ? `${KIND.paused.label} · ${relative(t.updatedAt, now)}` : `${KIND.shape.label} · low priority`, color: "faint" }],
        body: wrapStyled([{ text: oneLine(paused ? askLine(t) : (t.loop?.shape?.reason ?? "")), color: paused ? "warn" : "dim" }], inner).slice(0, 2),
        keys: paused
          ? [{ key: "↵", label: KIND.paused.action, input: "\r", hot: true }, { key: "e", label: "Explain the problem", input: "e" }]
          : [{ key: "↵", label: "Open", input: "\r" }, { key: "x", label: "Stop", input: "x" }],
      });
      continue;
    }
    if (item.kind === "memory") {
      const m = state.learning.memory.find((x) => x.id === item.key)!;
      cards.push({
        id: m.id,
        glyph: GLYPH.suggestion,
        tone: "info",
        title: "Add a line to CLAUDE.md?",
        meta: [...owner(m.spaceId), dot, { text: `${KIND.memory.label} · low priority`, color: "faint" }],
        body: wrapStyled([{ text: oneLine(m.line), color: "dim" }], inner).slice(0, 2),
        keys: [{ key: "y", label: KIND.memory.action, input: "y", hot: true }, { key: "n", label: "Not this", input: "n" }],
      });
      continue;
    }
    if (item.kind === "suggestion") {
      const p = state.proposals.find((x) => x.id === item.key)!;
      cards.push({
        id: p.id,
        glyph: GLYPH.suggestion,
        tone: "info",
        title: `Stop asking about ${p.label}?`,
        meta: [...owner(p.spaceId), dot, { text: `${KIND.suggestion.label} · you approved the last ${p.evidence.length} without changes`, color: "faint" }],
        body: [[{ text: "Atrium would approve these on its own. It still never merges or pushes.", color: "dim" }]],
        keys: [{ key: "y", label: KIND.suggestion.action, input: "y", hot: true }, { key: "n", label: "Not now", input: "n" }, { key: "N", label: "Never", input: "N" }, open],
      });
      continue;
    }
    const a = state.approvals.find((x) => x.id === item.key)!;
    const task = a.taskId ? state.tasks.find((t) => t.id === a.taskId) : undefined;
    if (a.kind === "review") {
      const told = task ? outcomeText(task.outcome, task.outcomeReason) : null;
      const notDone = task?.outcome === "couldnt" || task?.outcome === "partial";
      const review = reviewLine(a, state);
      cards.push({
        id: a.id,
        glyph: notDone ? GLYPH.notdone : "◆",
        tone: notDone ? "warn" : "accent",
        title: a.title,
        meta: [...owner(a.spaceId), dot, { text: task ? `${KIND.review.label} · ${agentText(task, state.runs)}${notDone ? " · says it isn't done" : ""} · ${relative(a.createdAt, now)}` : `${KIND.review.label} · ${relative(a.createdAt, now)}`, color: "faint" }],
        body: told
          ? wrapStyled([{ text: told, color: "warn" }], inner).slice(0, 2)
          : wrapStyled([{ text: oneLine(review?.text ?? a.detail.split("\n")[0] ?? ""), color: review?.tone === "bad" ? "warn" : "dim" }], inner).slice(0, 1),
        keys: [{ key: "a", label: notDone ? "Accept" : KIND.review.action, input: "a", hot: true }, { key: "s", label: "Send back", input: "s" }, { key: "↵", label: "Open", input: "\r" }, { key: "t", label: "Transcript", input: "t" }],
      });
      continue;
    }
    cards.push({
      id: a.id,
      glyph: "?",
      tone: "info",
      title: a.title,
      meta: [...owner(a.spaceId), dot, { text: `${KIND.approval.label} · ${relative(a.createdAt, now)}`, color: "faint" }],
      body: wrapStyled([{ text: oneLine(a.detail.split("\n").find((l) => l.trim()) ?? ""), color: "dim" }], inner).slice(0, 2),
      keys: [{ key: "a", label: KIND.approval.action, input: "a", hot: true }, { key: "s", label: a.spaceId === null ? "Decline" : "Send back", input: "s" }, open],
    });
  }
  return cards;
}

// A card: collapsed to its title and one line, or, when selected, everything with its keys.
function cardBlock(c: Card, selected: boolean, cols: number): Block {
  const title: Line = [{ text: `${c.glyph} `, color: c.tone }, { text: c.title, bold: selected, color: selected ? undefined : "dim" }];
  if (!selected) return { lines: box(title, [c.meta], cols, 3), hits: [{ x: 0, y: 0, w: cols, h: 3, click: { select: { pane: "needs", id: c.id } } }] };
  const body = [...c.body, c.meta, []];
  const rows = body.length + 3;
  const keys = keyRow(c.keys, 2, rows - 2);
  const lines = box(title, [...body, keys.line], cols, rows, "accent", true);
  const hits: Hit[] = [{ x: 0, y: 0, w: cols, h: rows, click: { select: { pane: "needs", id: c.id } } }, ...keys.hits.map((h) => ({ ...h, click: { ...h.click, select: { pane: "needs" as const, id: c.id } } }))];
  return { lines, hits };
}

function needsColumn(view: View, ui: Ui, cols: number, rows: number, now: number): Block {
  const cards = cardsOf(view, now, cols - 4);
  const selected = ui.selected.needs.id;
  const count = view.queue.filter((i) => !i.low).length;
  const head: Line = [{ text: " " }, label("Needs you"), ...(count ? [{ text: `  ${count}`, color: "accent" as const, bold: true }] : [])];
  if (!cards.length) {
    return { lines: [head, [], [{ text: ` ${GLYPH.ok} `, color: "ok" }, { text: "You're all caught up." }], [{ text: "   New things to decide show up here as cards.", color: "faint" }]], hits: [] };
  }
  const blocks = cards.map((c) => cardBlock(c, c.id === selected, cols - 2));
  const room = rows - 2;
  const at = Math.max(0, cards.findIndex((c) => c.id === selected));
  // Starts as high as it can while keeping the selected card whole on screen.
  let start = 0;
  const heightFrom = (from: number, to: number) => blocks.slice(from, to + 1).reduce((n, b) => n + b.lines.length, 0);
  while (start < at && heightFrom(start, at) > room - (start > 0 ? 1 : 0)) start++;
  const lines: Line[] = [head, []];
  const hits: Hit[] = [];
  if (start > 0) lines.push([{ text: `   ↑ ${start} more above`, color: "faint" }]);
  let shown = start;
  for (let i = start; i < blocks.length; i++) {
    const b = blocks[i]!;
    const left = rows - lines.length - (i < blocks.length - 1 ? 1 : 0);
    if (b.lines.length > left && i > at) break;
    hits.push(...shift(b.hits, 1, lines.length));
    lines.push(...b.lines.map((l) => [{ text: " " }, ...l]));
    shown = i + 1;
  }
  if (shown < blocks.length) lines.push([{ text: `   ↓ ${blocks.length - shown} more below · j`, color: "faint" }]);
  return { lines: lines.slice(0, rows), hits: hits.filter((h) => h.y < rows) };
}

function runningLines(view: View, d: HomeData): Line[] {
  const running = view.state.tasks.filter((t) => t.status === "running");
  const spin = SPINNER[d.frame % SPINNER.length]!;
  const runLines: Line[] = running.length
    ? running.slice(0, 2).flatMap((t, i): Line[] => {
        const run = view.state.runs.find((r) => r.taskId === t.id && r.endedAt === null);
        return [
          [{ text: `${spin} `, color: "ok" }, { text: t.title, bold: true }],
          [{ text: `  ${agentText(t, view.state.runs)}${run ? ` · ${duration(d.now - run.startedAt)}` : ""} · running`, color: "faint" }],
          ...(i === 0 && d.lastLine ? [[{ text: `  ${oneLine(d.lastLine)}`, color: "dim" as const }]] : []),
        ];
      })
    : [[{ text: "Nothing running.", color: "faint" }]];
  if (running.length > 2) runLines.push([{ text: `+${running.length - 2} more in Spaces`, color: "faint" }]);
  return runLines;
}

export function homeScreen(view: View, ui: Ui, d: HomeData, cols: number, rows: number): Block {
  const b = d.briefing;
  const greeting: Line = [{ text: `  ${b.greeting} `, bold: true }, { text: oneLine(`${b.summary}${liveStatus(view.state)}`), color: "dim" }];
  const top: Line[] = [greeting, []];
  const wide = cols >= 100;
  const running = view.state.tasks.filter((t) => t.status === "running").length;
  if (wide) {
    const leftW = cols - RIGHT - 3;
    const needs = needsColumn(view, ui, leftW, rows - 2, d.now);
    const t = runningLines(view, d);
    const right: Line[] = [
      [label("Running"), ...(running ? [{ text: `  ${running}`, color: "ok" as const, bold: true }] : [])],
      [],
      ...t,
    ];
    const divider = Array.from({ length: rows - 2 }, (): Line => [{ text: "│", color: "line" }]);
    const body = columns([{ lines: needs.lines, w: leftW }, { lines: divider, w: 1 }, { lines: right.map((l) => [{ text: " " }, ...l]), w: RIGHT + 2 }], rows - 2, 0);
    return { lines: rowsOf([...top, ...body], cols, rows), hits: shift(needs.hits, 0, 2) };
  }
  // Under 100 columns what's running folds into one line under the cards.
  const needs = needsColumn(view, ui, cols, rows - 4, d.now);
  const t = runningLines(view, d);
  const run: Line = [label("Running"), { text: "  " }, ...(t[0] ?? []), ...(running ? [{ text: ` · ${t[1]?.[0]?.text.trim() ?? ""}`, color: "faint" as const }] : [])];
  const lines = [...top, ...rowsOf(needs.lines, cols, rows - 4), [{ text: "─".repeat(cols), color: "line" as const }], [{ text: " " }, ...run]];
  return { lines: rowsOf(lines.map((l) => fit(l, cols)), cols, rows), hits: shift(needs.hits, 0, 2) };
}
