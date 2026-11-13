// Boxes drawn over a tab (help, confirms, pickers, the delete box) and the full views that take the body's place
// (transcript, agents and usage, a Needs you item's full text).
import { AGENT_IDS, agentName } from "../../dashboard/agents";
import { type SpaceDeletePreview, spaceDeleteLines } from "../../dashboard/deletion";
import { bytes, clock, tokens } from "../../dashboard/format";
import { AGENT_ROLES, agentStatus, reviewerName, runOutcome } from "../../dashboard/summary";
import type { ReviewChoice } from "../../engine/spaces";
import type { State } from "../../engine/state";
import { type Block, box, type Hit, keyRow, type Line, rowsOf, splice } from "../canvas";
import { type DetailLine, wrapStyled } from "../detail";
import { cursorParts } from "../edit";
import { answerChoices, helpFor } from "../keys";
import { truncate, width } from "../text";
import { GLYPH, windowGauge } from "../theme";
import type { Overlay, Ui } from "../ui";

const wrap = (text: string, cols: number, style: Omit<Line[number], "text"> = {}) => wrapStyled([{ text, ...style }], cols);

type Confirm = Extract<Overlay, { kind: "confirm" }>;

// What each confirm says, as lines, so it's tested without a terminal.
export function confirmLines(c: Confirm, state: State, cols: number): { title: string; lines: Line[]; keys: { key: string; label: string; input: string; hot?: boolean }[] } {
  const no = (label = "Not now") => ({ key: "n", label, input: "n" });
  if (c.purpose === "accept") {
    const a = state.approvals.find((x) => x.id === c.targetId);
    const task = a?.taskId ? state.tasks.find((t) => t.id === a.taskId) : undefined;
    const partial = task?.outcome === "partial";
    return {
      title: partial ? "Accept as is" : "Accept anyway",
      lines: [...wrap(partial ? "Accept as is? It says it's only partly done." : "Accept anyway? It says it couldn't do this.", cols), ...(task?.outcomeReason ? wrap(task.outcomeReason, cols, { color: "warn" }) : [])],
      keys: [{ key: "y", label: "Accept", input: "y", hot: true }, no()],
    };
  }
  if (c.purpose === "stop") {
    const task = state.tasks.find((t) => t.id === c.targetId);
    return {
      title: "Stop a running task",
      lines: [
        ...wrap(`Stop "${task?.title ?? "this task"}" now?`, cols, { bold: true }),
        [],
        ...wrap("The agent stops right away. Its edits so far are kept (on its branch in a repo), and the task waits as blocked until you retry it.", cols, { color: "dim" }),
      ],
      keys: [{ key: "y", label: "Stop it", input: "y", hot: true }, no("Keep running")],
    };
  }
  const name = state.spaces.find((s) => s.id === c.targetId)?.name ?? "this space";
  return { title: "Archive space", lines: wrap(`Archive ${name}? Its agents stop picking up tasks. X restores it.`, cols), keys: [{ key: "y", label: "Archive", input: "y", hot: true }, no("Keep it")] };
}

// A box centred over the body, with its keys as caps on the last line.
function floating(base: Line[], title: string, body: Line[], keys: { key: string; label: string; input: string; hot?: boolean }[], w: number, y0: number): Block {
  const cols = base[0] ? base[0].reduce((n, s) => n + width(s.text), 0) : w;
  const rows = body.length + (keys.length ? 4 : 2);
  const x = Math.max(0, Math.floor((cols - w) / 2));
  const y = Math.max(0, Math.floor((base.length - rows) / 2));
  const k = keyRow(keys, x + 2, y0 + y + rows - 2);
  const lines = box([{ text: title, bold: true, color: "accent" }], [...body, ...(keys.length ? [[], k.line] : [])], w, rows, "accent", true);
  const hits: Hit[] = [{ x, y: y0 + y, w, h: rows, click: {} }, ...k.hits];
  return { lines: splice(base, lines, x, y), hits };
}

export function confirmOver(base: Line[], c: Confirm, state: State, cols: number, y0: number): Block {
  const w = Math.min(58, cols - 4);
  const { title, lines, keys } = confirmLines(c, state, w - 4);
  return floating(base, title, lines, keys, w, y0);
}

export function deleteBoxLines(o: Extract<Overlay, { kind: "delete" }>, state: State, preview: SpaceDeletePreview | null, cols: number): { title: string; lines: Line[] } {
  const name = [...state.spaces, ...(state.archived ?? [])].find((s) => s.id === o.spaceId)?.name ?? "this space";
  const lines: Line[] = [];
  if (!preview) lines.push([{ text: "Counting what's in it…", color: "faint" }]);
  else {
    const { goes, stays } = spaceDeleteLines(preview);
    lines.push([{ text: "This removes:" }]);
    for (const g of goes) lines.push(...wrap(`  · ${g}`, cols));
    if (stays.length) lines.push([]);
    for (const l of stays) lines.push(...wrap(l, cols, { color: "faint" }));
    if (preview.refusal) lines.push([], ...wrap(preview.refusal, cols, { color: "bad" }));
  }
  const { before, at, after } = cursorParts(o);
  lines.push([], ...wrap(`Type ${name} to confirm. This can't be undone.`, cols), [{ text: "› ", color: "bad" }, { text: before }, { text: at, inverse: true }, { text: after }]);
  return { title: `Delete ${name} for good`, lines };
}

export function deleteOver(base: Line[], o: Extract<Overlay, { kind: "delete" }>, state: State, preview: SpaceDeletePreview | null, cols: number, y0: number): Block {
  const w = Math.min(66, cols - 4);
  const { title, lines } = deleteBoxLines(o, state, preview, w - 4);
  return floating(base, title, lines, [{ key: "enter", label: "Delete", input: "\r" }, { key: "esc", label: "Keep it", input: "\x1b" }], w, y0);
}

// A task's question, its answers numbered for one key each.
export function answerOver(base: Line[], o: Extract<Overlay, { kind: "answer" }>, state: State, cols: number, y0: number): Block {
  const task = state.tasks.find((t) => t.id === o.taskId);
  const question = task?.loop?.questions[o.step];
  const total = task?.loop?.questions.length ?? 1;
  const lines: Line[] = question
    ? answerChoices(question.options).map((choice, i) => {
        const mark = i === o.index;
        return [{ text: mark ? `${GLYPH.pointer} ` : "  ", color: "accent" }, { text: `${i + 1} `, color: "faint" }, { text: choice, bold: mark }];
      })
    : [[{ text: "That task isn't asking anything anymore.", color: "faint" }]];
  const title = `${total > 1 ? `${o.step + 1}/${total} · ` : ""}${question?.question ?? task?.title ?? "Question"}`;
  return floating(base, title, lines, [{ key: "1-9", label: "Answer", input: "1" }, { key: "esc", label: "Later", input: "\x1b" }], Math.min(60, cols - 4), y0);
}

export function pickerOver(base: Line[], p: Extract<Overlay, { kind: "picker" }>, state: State, reviewers: Record<string, string | null> | null, cols: number, y0: number): Block {
  const title = p.purpose === "agent" ? `Agent for ${state.tasks.find((t) => t.id === p.targetId)?.title ?? "this task"}` : `Reviewer for ${state.spaces.find((s) => s.id === p.targetId)?.name ?? "this space"}`;
  const lines: Line[] = p.options.map((id, i) => {
    const mark = i === p.index;
    return [
      { text: mark ? `${GLYPH.pointer} ` : "  ", color: "accent" },
      { text: p.purpose === "reviewer" ? reviewerName(id as ReviewChoice) : agentName(id), bold: mark },
      { text: p.purpose === "reviewer" && reviewers?.[id] ? " (can't work here)" : "", color: "bad" },
    ];
  });
  return floating(base, title, lines, [{ key: "enter", label: "Pick", input: "\r" }, { key: "esc", label: "Cancel", input: "\x1b" }], Math.min(50, cols - 4), y0);
}

export function helpOver(base: Line[], ui: Ui, cols: number, y0: number): Block {
  const w = Math.min(84, cols - 4);
  const keysCol = 12;
  const items = helpFor(ui.tab);
  const fitRows = Math.max(3, base.length - 6);
  const sections = new Set(items.map((h) => h.section)).size;
  // Two columns when one would run off the screen.
  const two = items.length + sections * 2 + 2 > fitRows && w >= 70;
  const col = two ? Math.floor((w - 4) / 2) : w - 4;
  const lines: Line[] = [];
  let section = "";
  for (const h of items) {
    if (h.section !== section) {
      if (section) lines.push([]);
      section = h.section;
      lines.push([{ text: section, bold: true, color: "accent" }]);
    }
    lines.push([{ text: h.keys.padEnd(keysCol), color: "info" }, { text: truncate(h.does, col - keysCol - 1) }]);
  }
  lines.push([], ...wrap("Clicks work on tabs, cards, rows and keys. To select text, drag with Option held in Terminal, Shift in Ghostty.", col, { color: "faint" }));
  if (!two) return floating(base, "Keys", lines.slice(0, fitRows), [{ key: "?", label: "Close", input: "?" }], w, y0);
  // Split at a section break near the middle, so a section isn't cut in two.
  const breaks = lines.flatMap((l, i) => (l.length === 0 ? [i] : []));
  const mid = breaks.reduce((best, i) => (Math.abs(i - lines.length / 2) < Math.abs(best - lines.length / 2) ? i : best), breaks[0] ?? Math.ceil(lines.length / 2));
  const left = lines.slice(0, mid);
  const right = lines.slice(mid + 1);
  const both = Array.from({ length: Math.max(left.length, right.length) }, (_, i): Line => [...rowsOf([left[i] ?? []], col, 1)[0]!, ...(right[i] ?? [])]);
  return floating(base, "Keys", both.slice(0, fitRows), [{ key: "?", label: "Close", input: "?" }], w, y0);
}

// A full view: its title in a box edge, then the lines already sliced to what shows, and how many are below.
export function fullView(title: string, lines: Line[], below: number, cols: number, rows: number): Line[] {
  const more = below > 0 ? ` · ${below} more below` : "";
  return box([{ text: title, bold: true }, { text: more, color: "faint" }], lines, cols, rows, "accent");
}

const RECENT_RUNS = 5;
const RESERVE_STEPS = [0.25, 0.5, 0.75];
const TONE = { bad: "bad", waiting: "warn" } as const;
const runDate = (ts: number) => new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

// Who can take work right now, what each has used, and Claude's window, as the dashboard's Agents page has it.
export function agentsLines(state: State): DetailLine[] {
  const lines: DetailLine[] = [];
  const tasks = new Map(state.tasks.map((t) => [t.id, t]));
  const ids = AGENT_IDS.filter((id) => state.agents[id]);
  if (ids.length === 0) lines.push([{ text: "No agents are set up in this engine.", color: "faint" }]);
  for (const id of ids) {
    const info = state.agents[id]!;
    const status = agentStatus(id, info, state);
    lines.push(
      [{ text: agentName(id), bold: true, color: "accent" }, { text: "  " }, { text: status.text, color: status.tone ? TONE[status.tone] : "ok" }, { text: `  · ${tokens(info.tokensToday)} tokens today`, color: "faint" }],
      [{ text: AGENT_ROLES[id] ?? "", color: "faint" }],
      [{ text: `Last check: ${info.detail || "not checked yet"}`, color: "faint" }],
    );
    if (info.limitedUntil) lines.push([{ text: `Limit resets ${clock(info.limitedUntil)}`, color: "warn" }]);
    if (id === "claude") {
      const w = state.claudeWindow;
      const g = windowGauge(state, 30);
      lines.push(
        "text" in g
          ? [{ text: g.text, color: "faint" }]
          : [{ text: "Claude 5h ", color: "dim" }, { text: GLYPH.meter.repeat(g.filled), color: g.tone === "warn" ? "warn" : "accent" }, { text: GLYPH.meterEmpty.repeat(g.empty), color: "line" }, { text: g.pct, color: g.tone === "warn" ? "warn" : undefined }, { text: w ? ` · resets ${clock(w.resetsAt)}` : "", color: "faint" }],
        [
          { text: "Pause Claude tasks at " },
          ...RESERVE_STEPS.map((step) => {
            const pct = `${Math.round(step * 100)}%`;
            const on = state.usage.claudeReserve === step;
            return { text: on ? `[${pct}] ` : ` ${pct}  `, bold: on, color: on ? ("accent" as const) : ("faint" as const) };
          }),
          { text: "used  ([ ] to change; Run now on a task skips this)", color: "faint" },
        ],
        [{ text: "Estimated from Claude's own limit reports; Atrium can't see your exact quota.", color: "faint" }],
      );
    }
    const runs = state.runs.filter((r) => r.agent === id).slice(0, RECENT_RUNS);
    if (runs.length > 0) {
      lines.push([{ text: "Recent runs", bold: true }]);
      for (const r of runs) lines.push([{ text: `${runDate(r.startedAt)}  `, color: "faint" }, { text: tasks.get(r.taskId)?.title ?? "Task no longer listed" }, { text: `  ${runOutcome(r)}  ${tokens(r.inputTokens + r.outputTokens)} tokens`, color: "faint" }]);
    }
    lines.push([]);
  }
  lines.push([
    {
      text: [
        `Claude · last 24h ${tokens(state.usage.claudeTokens24h)} tokens`,
        state.power.source === "ac" ? "Plugged in" : "On battery · heavy work waits",
        `Overnight mode ${state.power.overnight ? "on" : "off"} (o)`,
        `Atrium disk usage ${bytes(state.disk.totalBytes)}`,
      ].join(" · "),
      color: "faint",
    },
  ]);
  return lines;
}
