// Spaces: the spaces and the selected space's tasks on the left, the detail and the live agent on the right.
// Everything the Plan 3 panes did, in the new look.
import { agentText, needsAction, waitOf } from "../../dashboard/agents";
import { duration } from "../../dashboard/format";
import { distinctWaits, shownTitle, spaceStatus, STATUS_TEXT } from "../../dashboard/summary";
import { outcomeLabel } from "../../engine/outcome";
import { type Block, columns, fit, type Hit, label, type Line, rowsOf, rule, type Seg } from "../canvas";
import { type DetailLine, wrapStyled } from "../detail";
import { pick, type View } from "../select";
import { tail, truncate, viewport, width } from "../text";
import { GLYPH, SPINNER, STATUS_GLYPH, spaceTone, type Tone } from "../theme";
import type { ListPane, Pane, Ui } from "../ui";

export const leftWidth = (cols: number) => Math.min(44, Math.max(28, Math.floor(cols * 0.34)));
// Detail gets a little more than half the right column; live the rest, with its own header row.
export const detailRows = (rows: number) => Math.floor(rows * 0.58);
const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - width(s)));

// A list row: the ▌ bar marks the selection in every pane; the focused pane's selected row also gets the soft fill.
function row(segs: Line, cols: number, selected: boolean, focused: boolean): Line {
  if (!selected) return fit([{ text: "  " }, ...segs], cols);
  const fill = focused ? { bg: "soft" as const } : {};
  return fit([{ text: GLYPH.sel, color: focused ? "accent" : "faint" }, { text: " ", ...fill }, ...segs.map((s) => ({ ...s, ...fill, bold: s.bold || focused }))], cols, fill);
}

function header(text: string, focused: boolean, filter: string, extra: Line = []): Line {
  return [{ text: " " }, { ...label(text), color: focused ? "accent" : "faint" }, ...extra, ...(filter ? [{ text: `  /${filter}`, color: "info" as const }] : [])];
}

function list<T extends { id: string }>(o: {
  items: T[];
  pane: ListPane & ("spaces" | "tasks");
  ui: Ui;
  focused: boolean;
  cols: number;
  rows: number;
  y: number;
  empty: string;
  render: (item: T) => Line;
}): Block {
  if (!o.items.length) return { lines: wrapStyled([{ text: o.empty, color: "faint" }], o.cols - 3).slice(0, o.rows).map((l) => [{ text: "  " }, ...l]), hits: [] };
  const { index } = pick(o.items, o.ui.selected[o.pane]);
  const pinnedHere = o.ui.selected[o.pane].id !== null && o.items[index]?.id === o.ui.selected[o.pane].id;
  const { top, rows: shown } = viewport(o.items, index, o.rows);
  return {
    lines: shown.map((item, i) => row(o.render(item), o.cols, pinnedHere && top + i === index, o.focused)),
    hits: shown.map((item, i): Hit => ({ x: 0, y: o.y + i, w: o.cols, h: 1, click: { select: { pane: o.pane, id: item.id }, focus: o.pane }, wheel: "list" })),
  };
}

const TONE: Record<string, Tone> = { blocked: "bad", waiting: "warn" };

function spaceRow(view: View, cols: number) {
  const nameWidth = Math.min(16, Math.max(0, ...view.spaces.map((s) => width(s.name))));
  return (space: View["spaces"][number]): Line => {
    if (space.status === "archived") return [{ text: "○ ", color: "faint" }, { text: `${pad(truncate(space.name, nameWidth), nameWidth)}  `, color: "faint" }, { text: "archived", color: "faint" }];
    const status = spaceStatus(space, view.state.tasks.filter((t) => t.spaceId === space.id), view.state);
    const room = Math.max(4, cols - 4 - nameWidth - 2);
    return [
      { text: "● ", color: spaceTone(view.state.spaces.indexOf(space)) },
      { text: `${pad(truncate(space.name, nameWidth), nameWidth)}  ` },
      { text: truncate(status.text, room), color: status.tone ? TONE[status.tone] : "faint" },
    ];
  };
}

function taskRow(view: View, cols: number, frame: number) {
  return (task: View["tasks"][number]): Line => {
    const notDone = task.status === "done" && task.outcome ? outcomeLabel(task.outcome) : null;
    // A finished task the agent said it couldn't or only partly do never wears the done check.
    const glyph = notDone ? { glyph: GLYPH.notdone, color: "warn" as Tone } : task.status === "running" ? { glyph: SPINNER[frame % SPINNER.length]!, color: "ok" as Tone } : STATUS_GLYPH[task.status];
    const wait = waitOf(task, view.state);
    const word = wait ? "waiting" : (notDone ?? STATUS_TEXT[task.status]);
    const tone: Tone = wait ? (needsAction(wait) ? "bad" : "warn") : notDone ? "warn" : task.status === "blocked" || task.status === "failed" ? "bad" : task.status === "running" ? "ok" : "faint";
    const kind = task.kind === "work" ? "" : `${task.kind} · `;
    const room = Math.max(1, cols - 4 - width(word) - 1 - width(kind));
    return [
      { text: `${glyph.glyph} `, color: glyph.color },
      { text: kind, color: "info" },
      { text: pad(truncate(shownTitle(task), room), room) },
      { text: ` ${word}`, color: tone },
    ];
  };
}

function detailTitle(view: View): string {
  if (view.subject === "task") return view.task ? shownTitle(view.task) : "Detail";
  return view.space?.name ?? "Detail";
}

export type SpacesData = { detail: DetailLine[]; live: string[]; frame: number; now: number };

export function spacesScreen(view: View, ui: Ui, d: SpacesData, cols: number, rows: number, y0: number): Block {
  const L = leftWidth(cols);
  const R = cols - L - 1;
  const focus = (p: Pane) => ui.focus === p;
  const spaceRows = Math.max(3, Math.floor(rows * 0.4) - 1);
  const spaces = list({ items: view.spaces, pane: "spaces", ui, focused: focus("spaces"), cols: L, rows: spaceRows, y: y0 + 1, empty: "No spaces yet. Press N and describe one.", render: spaceRow(view, L) });
  const taskTop = spaceRows + 2;
  const tasks = list({
    items: view.tasks,
    pane: "tasks",
    ui,
    focused: focus("tasks"),
    cols: L,
    rows: rows - taskTop - 1,
    y: y0 + taskTop + 1,
    empty: view.space ? `No tasks yet. Press n to give ${view.space.name} one.` : "Pick a space above to see its tasks.",
    render: taskRow(view, L, d.frame),
  });
  const left: Line[] = [
    header("Spaces", focus("spaces"), ui.filters.spaces),
    ...rowsOf(spaces.lines, L, spaceRows),
    [],
    header("Tasks", focus("tasks"), ui.filters.tasks, view.space ? [{ text: ` · ${view.space.name}`, color: "faint" }] : []),
    ...tasks.lines,
  ];

  // Detail: wrapped already; the made file picked with f is kept on screen.
  const dRows = detailRows(rows);
  const shown = dRows - 1;
  const picked = ui.detailFile === null ? -1 : d.detail.findIndex((l) => l[0]?.text.startsWith("▸ "));
  let top = Math.min(ui.detailScroll, Math.max(0, d.detail.length - shown));
  if (picked >= 0 && (picked < top || picked >= top + shown)) top = Math.max(0, Math.min(picked - Math.floor(shown / 2), d.detail.length - shown));
  const more = d.detail.length > top + shown ? `  ↓ ${d.detail.length - top - shown} more` : "";
  const detailHead: Line = [{ text: " " }, { ...label(view.subject === "task" ? "Task" : "Space"), color: focus("detail") ? "accent" : "faint" }, { text: `  ${detailTitle(view)}`, bold: true }, { text: more, color: "faint" }];
  const right: Line[] = [detailHead, ...d.detail.slice(top, top + shown).map((l) => [{ text: " " }, ...l])];
  while (right.length < dRows) right.push([]);

  // Live: the selected space's running agent, its task, and the tail of its output.
  const live = view.live;
  const lRows = rows - dRows;
  const liveLabel: Seg = { ...label("Live"), color: focus("live") ? "accent" : "faint" };
  if (!live) {
    const waits = view.space ? distinctWaits(view.state.tasks.filter((t) => t.spaceId === view.space!.id), view.state) : [];
    right.push(
      rule([liveLabel], R),
      [{ text: " No agent working here right now.", color: "faint" }],
      ...waits.map((w): Line => [{ text: ` ${GLYPH.notdone} ${w.reason}`, color: needsAction(w) ? "bad" : "warn" }]),
    );
  } else {
    const paused = ui.liveScroll !== null ? " · paused, G to follow" : "";
    right.push(
      rule([liveLabel, { text: ` · ${agentText(live.task, view.state.runs)} · running ${duration(d.now - live.run.startedAt)}${paused}`, color: "dim" }], R),
      [{ text: ` ${SPINNER[d.frame % SPINNER.length]} `, color: "ok" }, { text: `${live.task.kind === "work" ? "" : `${live.task.kind} · `}${shownTitle(live.task)}`, bold: true }, { text: "  . stops it", color: "faint" }],
      ...(d.live.length ? tail(d.live, lRows - 2, ui.liveScroll).map((l): Line => [{ text: ` ${l}` }]) : [[{ text: " Waiting for the agent's first words…", color: "faint" } as Seg]]),
    );
  }
  const divider = Array.from({ length: rows }, (): Line => [{ text: "│", color: "line" }]);
  const lines = columns([{ lines: left, w: L }, { lines: divider, w: 1 }, { lines: right, w: R }], rows);
  const hits: Hit[] = [
    { x: L + 1, y: y0, w: R, h: dRows, click: { focus: "detail" }, wheel: "detail" },
    { x: L + 1, y: y0 + dRows, w: R, h: lRows, click: { focus: "live" }, wheel: "live" },
    ...spaces.hits,
    ...tasks.hits,
  ];
  return { lines, hits };
}

// How many detail and live lines are on screen, for scrolling.
export const spacesRows = (rows: number) => ({ detail: detailRows(rows) - 1, live: rows - detailRows(rows) - 2 });
