// What the Detail pane says about the selected thing, as styled lines. Pure, so it's tested without a terminal.
import { agentName, agentText, needsAction, verdictOf, waitOf } from "../dashboard/agents";
import { absolute, clock, duration, relative, tokens } from "../dashboard/format";
import { actorName, reviewHint, reviewLine, runOutcome, spaceStatus, STATUS_TEXT } from "../dashboard/summary";
import type { Message } from "../engine/messages";
import type { State } from "../engine/state";
import type { View } from "./select";
import { clean, width } from "./text";
import { type AnsiColor, color, STATUS_GLYPH } from "./theme";

type Run = State["runs"][number];

export type Styled = { text: string; color?: AnsiColor; bold?: boolean; dim?: boolean };
export type DetailLine = Styled[];

const SPACE_ACTIVITY = 10;
const TONE = { ok: color.ok, waiting: color.warn, bad: color.bad } as const;

const blank: DetailLine = [];
const plain = (text: string, style: Omit<Styled, "text"> = {}): DetailLine => [{ text, ...style }];
const muted = (text: string) => plain(text, { color: color.muted });
const heading = (text: string): DetailLine => plain(text, { bold: true, color: color.accent });
// Multi-line text (task detail, agent messages) becomes one detail line per source line.
const block = (text: string, style: Omit<Styled, "text"> = {}) => clean(text).split("\n").map((l) => plain(l, style));

const runDate = (ts: number) =>
  new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function runRow(run: Run): DetailLine {
  const outcome = runOutcome(run);
  const after = run.endedAt !== null ? ` after ${duration(run.endedAt - run.startedAt)}` : "";
  return [
    { text: `${runDate(run.startedAt)}  ` },
    { text: `${outcome}${after}`, color: outcome === "ended without finishing" ? color.bad : undefined },
    { text: `  ${tokens(run.inputTokens)} in · ${tokens(run.outputTokens)} out`, color: color.muted },
  ];
}

function thread(messages: Message[] | null): DetailLine[] {
  if (!messages?.length) return [];
  return [
    blank,
    heading("Agent thread"),
    ...messages.flatMap((m) => {
      const verdict = verdictOf(m.body);
      const head: DetailLine = [
        { text: `${agentName(m.fromAgent)} → ${agentName(m.toAgent)}`, bold: true },
        { text: `  ${clock(m.createdAt)}`, color: color.muted },
      ];
      if (verdict) {
        head.push({ text: `  ${verdict === "approve" ? "approves" : "asks for changes"}`, color: verdict === "approve" ? color.ok : color.warn });
      }
      return [head, ...block(m.body)];
    }),
  ];
}

export function taskDetail(view: View, messages: Message[] | null): DetailLine[] {
  const task = view.task;
  if (!task) return [muted("Pick a task in [2] to see its detail.")];
  const { state } = view;
  const glyph = STATUS_GLYPH[task.status];
  const wait = waitOf(task, state);
  const parent = task.parentTaskId ? state.tasks.find((t) => t.id === task.parentTaskId) : undefined;
  const runs = state.runs.filter((r) => r.taskId === task.id);
  const lines: DetailLine[] = [
    [
      { text: `${glyph.glyph} `, color: glyph.color },
      { text: wait ? "waiting" : STATUS_TEXT[task.status], color: wait ? (needsAction(wait) ? color.bad : color.warn) : glyph.color, bold: true },
      { text: ` · ${agentText(task, state.runs)}`, color: color.muted },
    ],
  ];
  if (task.status === "blocked" && task.blockedReason) lines.push(plain(task.blockedReason, { color: color.bad }));
  // Wait reasons can name a command in backticks; they're kept as written so it can be copied.
  if (wait) lines.push(plain(wait.reason, { color: needsAction(wait) ? color.bad : color.warn }));
  if (parent) {
    lines.push(muted(`${task.kind === "review" ? "Reviews" : "Fixes what the review found in"} “${parent.title}”`));
  }
  lines.push(blank, ...block(task.detail || task.title), blank);
  lines.push(
    [{ text: "Agent ", color: color.muted }, { text: agentText(task, state.runs) }],
    muted(`Added ${relative(task.createdAt)} (${absolute(task.createdAt)}) · Updated ${relative(task.updatedAt)}`),
  );
  if (task.branch) lines.push(muted(`Branch ${task.branch}`));
  lines.push(muted(task.weight === "heavy" ? "Heavy · runs when plugged in" : "Light · runs anytime"));
  if (task.ignoreReserve) lines.push(muted("Runs during Claude's reserve"));
  if (task.kind === "work") lines.push(...thread(messages));
  lines.push(blank, heading("Runs"));
  if (runs.length === 0) lines.push(muted("No runs yet."));
  else lines.push(...runs.map(runRow), muted("t transcript · [ ] older / newer run"));
  return lines;
}

export function approvalDetail(view: View, messages: Message[] | null): DetailLine[] {
  const approval = view.approval;
  if (!approval) return [muted("Nothing needs you right now.")];
  const space = view.state.spaces.find((s) => s.id === approval.spaceId);
  const review = reviewLine(approval, view.state, messages);
  const lines: DetailLine[] = [muted(space?.name ?? "Unknown space"), plain(approval.title, { bold: true })];
  if (review) lines.push(plain(review.text, { color: review.tone ? TONE[review.tone] : undefined }));
  lines.push(blank, ...block(approval.detail || "No further detail."), blank);
  lines.push(muted(`Asked ${relative(approval.createdAt)} (${absolute(approval.createdAt)})`));
  lines.push(muted("a approve · r send back · enter on the task in [2] for runs · t transcript"));
  return lines;
}

export function spaceDetail(view: View, reviewers: Record<string, string | null> | null): DetailLine[] {
  const space = view.space;
  if (!space) return [muted("No spaces yet. Press N to describe one.")];
  const { state } = view;
  const tasks = state.tasks.filter((t) => t.spaceId === space.id);
  const status = spaceStatus(space, tasks, state);
  const head: DetailLine = [{ text: space.name, bold: true }, { text: `  ${space.kind}`, color: color.muted }];
  if (space.private) head.push({ text: "  Private · only Claude works here", color: color.info });
  const lines: DetailLine[] = [head];
  if (space.repoPath) lines.push(muted(space.repoPath));
  lines.push(plain(space.goal || "No goal yet. Press e to add one."));
  lines.push(plain(status.text, { color: status.tone === "blocked" ? color.bad : status.tone === "waiting" ? color.warn : undefined }));
  // Reviews read the branch diff, so only repo spaces have anything to review.
  if (space.kind === "repo") {
    const reason = space.reviewBy ? reviewers?.[space.reviewBy] : null;
    lines.push(blank, [
      { text: "Reviewer ", color: color.muted },
      { text: space.reviewBy ? agentName(space.reviewBy) : "No one" },
      { text: "  (v to change)", color: color.muted },
    ]);
    lines.push(
      reason
        ? plain(`${reason} Reviews will be skipped until you pick another reviewer.`, { color: color.bad })
        : muted(reviewHint(space.reviewBy)),
    );
  }
  const activity = state.activity.filter((a) => a.spaceId === space.id).slice(0, SPACE_ACTIVITY);
  lines.push(blank, heading("Recent activity"));
  if (activity.length === 0) lines.push(muted("Nothing yet."));
  for (const a of activity) {
    lines.push([{ text: `${relative(a.createdAt)}  `, color: color.muted }, { text: `${actorName(a.actor)}: ${a.message}` }]);
  }
  return lines;
}

export function activityDetail(view: View): DetailLine[] {
  const row = view.activityRow;
  if (!row) return [muted("No activity yet. Agent runs and your decisions will show up here.")];
  const space = row.spaceId ? view.state.spaces.find((s) => s.id === row.spaceId) : undefined;
  return [
    [{ text: actorName(row.actor), bold: true }, ...(space ? [{ text: ` · ${space.name}`, color: color.info }] : [])],
    muted(absolute(row.createdAt)),
    blank,
    ...block(row.message),
    ...(space ? [blank, muted("enter opens this space")] : []),
  ];
}

const segmenter = new Intl.Segmenter();

type Cell = { g: string; i: number };

// Wraps one styled line to `cols` at word boundaries where it can (hard-breaking a word longer than a line),
// keeping each piece's style on both sides of a break.
export function wrapStyled(line: DetailLine, cols: number): DetailLine[] {
  const cells: Cell[] = line.flatMap((seg, i) => Array.from(segmenter.segment(seg.text), ({ segment }) => ({ g: segment, i })));
  const rows: Cell[][] = [];
  let cur: Cell[] = [];
  const used = () => cur.reduce((n, c) => n + width(c.g), 0);
  for (const cell of cells) {
    if (used() + width(cell.g) <= cols || cur.length === 0) {
      cur.push(cell);
      continue;
    }
    const space = cur.map((c) => c.g).lastIndexOf(" ");
    // Carry the unfinished word down, unless the word is the whole row.
    const carry = cell.g !== " " && space > 0 ? cur.splice(space + 1) : [];
    while (cur.at(-1)?.g === " ") cur.pop();
    rows.push(cur);
    cur = cell.g === " " ? carry : [...carry, cell];
  }
  rows.push(cur);
  return rows.map((row) => {
    const out: (Styled & { i: number })[] = [];
    for (const { g, i } of row) {
      const last = out.at(-1);
      if (last?.i === i) last.text += g;
      else out.push({ ...line[i]!, text: g, i });
    }
    return out.map(({ i: _, ...seg }) => seg);
  });
}
