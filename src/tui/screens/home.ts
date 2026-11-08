// Home: the briefing, Needs you as cards with their actions on them, and Today beside them (below them under 100
// columns): the portfolio, money this month, and what's running.
import { agentText } from "../../dashboard/agents";
import { duration, relative } from "../../dashboard/format";
import { liveStatus } from "../../dashboard/summary";
import type { GlanceView } from "../../engine/markets/views";
import type { MoneySummary } from "../../engine/money/summary";
import { displayHandle, hasTarget, memberNames, recipientOf } from "../../engine/messaging/rules";
import { outcomeText } from "../../engine/outcome";
import { bar, type Block, box, columns, fit, type Hit, keyRow, label, type Line, rowsOf, shift } from "../canvas";
import { wrapStyled } from "../detail";
import type { View } from "../select";
import { oneLine } from "../text";
import { GLYPH, SPINNER, spaceTone, type Tone } from "../theme";
import type { Ui } from "../ui";
import { cad, change, hourText, monthName } from "./format";

export type HomeData = {
  glance: GlanceView | null;
  money: MoneySummary | null;
  // Whether there's an Investing space at all, so Today can say how to get one.
  investing: boolean;
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

function cardsOf(view: View, now: number, inner: number): Card[] {
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
  for (const p of view.proposals) {
    cards.push({
      id: p.id,
      glyph: GLYPH.suggestion,
      tone: "info",
      title: `Stop asking about ${p.label}?`,
      meta: [...owner(p.spaceId), dot, { text: `You approved the last ${p.evidence.length} without changes`, color: "faint" }],
      body: [[{ text: "Atrium would approve these on its own. It still never merges, pushes or messages anyone new.", color: "dim" }]],
      keys: [{ key: "y", label: "Yes", input: "y", hot: true }, { key: "n", label: "Not now", input: "n" }, { key: "N", label: "Never", input: "N" }, open],
    });
  }
  for (const a of view.approvals) {
    const text = a.alwaysAsk === "send_message" ? state.messageActions.find((m) => m.approvalId === a.id) : undefined;
    if (text?.group) {
      const g = text.group;
      const quote = wrapStyled([{ text: `"${oneLine(text.text)}"`, italic: true }], inner).slice(0, 2);
      const people = memberNames(g);
      cards.push({
        id: a.id,
        glyph: GLYPH.text,
        tone: "accent",
        title: `Group text to ${recipientOf(text)}`,
        meta: [
          { text: "to ", color: "faint" },
          { text: recipientOf(text), color: "dim" },
          dot,
          g.chat ? { text: `group chat · ${g.chat.participants.length} people`, color: "faint" } : { text: `${GLYPH.notdone} group chat needed`, color: "warn" },
          dot,
          { text: `${text.service} · drafted ${relative(a.createdAt, now)}`, color: "faint" },
        ],
        body: [
          ...quote,
          ...wrapStyled([{ text: people.length ? `People: ${people.join(", ")}` : "People: not known until you find the chat", color: "dim" }], inner).slice(0, 2),
          ...(text.lastError ? [[{ text: `${GLYPH.bad} Last try failed: ${text.lastError}`, color: "bad" as const }]] : []),
          ...(g.chat ? [] : [[{ text: "Find the group chat on the dashboard, then send it here.", color: "dim" as const }]]),
        ],
        keys: [...(hasTarget(text) ? [{ key: "s", label: "Send", input: "s", hot: true }] : []), { key: "e", label: "Edit", input: "e" }, { key: "x", label: "Skip", input: "x" }],
      });
      continue;
    }
    if (text) {
      const quote = wrapStyled([{ text: `"${oneLine(text.text)}"`, italic: true }], inner).slice(0, 2);
      cards.push({
        id: a.id,
        glyph: GLYPH.text,
        tone: "accent",
        title: `Text to ${text.toName}`,
        meta: [{ text: "to ", color: "faint" }, { text: text.toName, color: "dim" }, dot, text.handle ? { text: displayHandle(text.handle), color: "faint" } : { text: `${GLYPH.notdone} number needed`, color: "warn" }, dot, { text: `${text.service} · drafted ${relative(a.createdAt, now)}`, color: "faint" }],
        body: [...quote, ...(text.lastError ? [[{ text: `${GLYPH.bad} Last try failed: ${text.lastError}`, color: "bad" as const }]] : []), ...(text.handle ? [] : [[{ text: "Pick who this goes to on the dashboard, then send it here.", color: "dim" as const }]])],
        keys: [...(text.handle ? [{ key: "s", label: "Send", input: "s", hot: true }] : []), { key: "e", label: "Edit", input: "e" }, { key: "x", label: "Skip", input: "x" }],
      });
      continue;
    }
    const task = a.taskId ? state.tasks.find((t) => t.id === a.taskId) : undefined;
    if (a.kind === "review") {
      const told = task ? outcomeText(task.outcome, task.outcomeReason) : null;
      const notDone = task?.outcome === "couldnt" || task?.outcome === "partial";
      cards.push({
        id: a.id,
        glyph: notDone ? GLYPH.notdone : "◆",
        tone: notDone ? "warn" : "accent",
        title: a.title,
        meta: [...owner(a.spaceId), dot, { text: task ? `${agentText(task, state.runs)} · ${notDone ? "says it isn't done" : "ready for review"} · ${relative(a.createdAt, now)}` : `ready for review · ${relative(a.createdAt, now)}`, color: "faint" }],
        body: told ? wrapStyled([{ text: told, color: "warn" }], inner).slice(0, 2) : wrapStyled([{ text: oneLine(a.detail.split("\n")[0] ?? ""), color: "dim" }], inner).slice(0, 1),
        keys: [{ key: "a", label: notDone ? "Accept" : "Approve", input: "a", hot: true }, { key: "r", label: "Send back", input: "r" }, { key: "↵", label: "Open", input: "\r" }, { key: "t", label: "Transcript", input: "t" }],
      });
      continue;
    }
    const alert = a.kind === "alert";
    cards.push({
      id: a.id,
      glyph: alert ? GLYPH.notdone : "?",
      tone: alert ? "warn" : "info",
      title: a.title,
      meta: [...owner(a.spaceId), dot, { text: `${alert ? "alert" : "asks you"} · ${relative(a.createdAt, now)}`, color: "faint" }],
      body: wrapStyled([{ text: oneLine(a.detail.split("\n").find((l) => l.trim()) ?? ""), color: "dim" }], inner).slice(0, 2),
      keys: alert
        ? [{ key: "a", label: "Dismiss", input: "a", hot: true }, open]
        : [{ key: "a", label: "Approve", input: "a", hot: true }, { key: "r", label: a.spaceId === null ? "Decline" : "Send back", input: "r" }, open],
    });
  }
  for (const n of view.nudges) {
    cards.push({
      id: n.id,
      glyph: GLYPH.suggestion,
      tone: "info",
      title: n.title,
      meta: [{ text: n.spaceName, color: "dim" }, dot, { text: "reminder", color: "faint" }],
      body: wrapStyled([{ text: n.body, color: "dim" }], inner).slice(0, 2),
      keys: [{ key: "↵", label: "Open Money", input: "\r", hot: true }, { key: "x", label: "Dismiss", input: "x" }],
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
  const head: Line = [{ text: " " }, label("Needs you"), ...(cards.length ? [{ text: `  ${cards.length}`, color: "accent" as const, bold: true }] : [])];
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

type Today = { portfolio: Line[]; money: Line[]; running: Line[] };

function today(view: View, d: HomeData, cols: number): Today {
  const g = d.glance;
  const p = g?.portfolio;
  const portfolio: Line[] = !d.investing
    ? [[{ text: "Portfolio", color: "dim" }], [{ text: "No Investing space yet.", color: "faint" }]]
    : !g
      ? [[{ text: "Portfolio", color: "dim" }], [{ text: "Loading…", color: "faint" }]]
      : !p || p.totalCad === null
        ? [[{ text: "Portfolio", color: "dim" }], [{ text: "No holdings yet. Import them in the app.", color: "faint" }]]
        : [
            [{ text: "Portfolio", color: "dim" }, { text: `  ${p.dayLabel ?? "today"}`, color: "faint" }],
            [{ text: cad(p.totalCad, 0), bold: true }, { text: "   " }, change(p.dayPct)],
            ...(p.mix ? [[{ text: p.mix, color: "faint" as const }]] : []),
          ];
  const next = g?.earnings[0];
  if (next) portfolio.push([{ text: `${next.key} earnings ${next.date.slice(5).replace("-", "/")}, ${hourText(next.hour)}`, color: "faint" }]);
  const m = d.money;
  // Budgets cover some categories, so the bar compares what those categories spent with their limits.
  const budget = m ? m.budgets.reduce((n, b) => n + b.limit, 0) : 0;
  const inBudget = m ? m.budgets.reduce((n, b) => n + b.spent, 0) : 0;
  const money: Line[] = !d.investing
    ? []
    : !m?.month
      ? [[{ text: "Money", color: "dim" }], [{ text: m ? "Nothing imported yet. Press 3." : "Loading…", color: "faint" }]]
      : [
          [{ text: `Money · ${monthName(m.month)}`, color: "dim" }, { text: `  ${cad(m.spent, 0)} spent`, color: "faint" }],
          budget > 0 ? [{ text: cad(inBudget, 0), bold: true }, { text: ` of ${cad(budget, 0)} budgeted`, color: "faint" }] : [{ text: "No budgets set. Press 3, then b.", color: "faint" }],
          ...(budget > 0 ? [budgetBar(inBudget / budget, Math.min(18, cols - 10))] : []),
        ];
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
  return { portfolio, money, running: runLines };
}

function budgetBar(frac: number, cells: number): Line {
  const tone: Tone = frac >= 1 ? "bad" : frac >= 0.8 ? "warn" : "accent";
  const note = frac >= 1 ? ` ${GLYPH.notdone} over` : frac >= 0.8 ? ` ${GLYPH.notdone}` : "";
  return [...bar(Math.min(1, frac), cells, tone), { text: ` ${Math.round(frac * 100)}%${note}`, color: frac >= 0.8 ? tone : "dim" }];
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
    const t = today(view, d, RIGHT - 1);
    const right: Line[] = [
      [label("Today")],
      [],
      ...t.portfolio,
      [],
      ...(t.money.length ? [...t.money, []] : []),
      [label("Running"), ...(running ? [{ text: `  ${running}`, color: "ok" as const, bold: true }] : [])],
      [],
      ...t.running,
    ];
    const divider = Array.from({ length: rows - 2 }, (): Line => [{ text: "│", color: "line" }]);
    const body = columns([{ lines: needs.lines, w: leftW }, { lines: divider, w: 1 }, { lines: right.map((l) => [{ text: " " }, ...l]), w: RIGHT + 2 }], rows - 2, 0);
    return { lines: rowsOf([...top, ...body], cols, rows), hits: shift(needs.hits, 0, 2) };
  }
  // Under 100 columns Today folds into two lines under the cards.
  const needs = needsColumn(view, ui, cols, rows - 5, d.now);
  const t = today(view, d, cols);
  const glance: Line = [label("Today"), { text: "  " }, ...(t.portfolio[1] ?? []), ...(t.money[1] ? [{ text: "  ·  ", color: "faint" as const }, { text: t.money[0]![0]!.text.replace("Money · ", ""), color: "dim" as const }, { text: " " }, ...t.money[1]!] : [])];
  const run: Line = [label("Running"), { text: "  " }, ...(t.running[0] ?? []), ...(running ? [{ text: ` · ${t.running[1]?.[0]?.text.trim() ?? ""}`, color: "faint" as const }] : [])];
  const lines = [...top, ...rowsOf(needs.lines, cols, rows - 5), [{ text: "─".repeat(cols), color: "line" as const }], [{ text: " " }, ...glance], [{ text: " " }, ...run]];
  return { lines: rowsOf(lines.map((l) => fit(l, cols)), cols, rows), hits: shift(needs.hits, 0, 2) };
}
