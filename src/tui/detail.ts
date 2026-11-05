// What the Detail pane says about the selected thing, as styled lines. Pure, so it's tested without a terminal.
import { agentName, agentText, needsAction, verdictOf, waitOf } from "../dashboard/agents";
import { absolute, clock, duration, relative, tokens } from "../dashboard/format";
import { actorName, reviewHint, reviewLine, runOutcome, spaceStatus, STATUS_TEXT } from "../dashboard/summary";
import type { Message } from "../engine/messages";
import type { State } from "../engine/state";
import { money } from "../engine/markets/labels";
import { plural } from "../engine/text";
import type { MarketsGlance } from "./client";
import type { View } from "./select";
import { clean, width } from "./text";
import { type AnsiColor, color, STATUS_GLYPH } from "./theme";

type Run = State["runs"][number];

export type Styled = { text: string; color?: AnsiColor; bold?: boolean; dim?: boolean };
export type DetailLine = Styled[];

const SPACE_ACTIVITY = 10;
const TONE = { ok: color.ok, waiting: color.warn, bad: color.bad } as const;

const blank: DetailLine = [];
const signedMoney = (n: number) => `${n >= 0 ? "+" : "−"}${money(Math.abs(n), "USD")}`;
const plain = (text: string, style: Omit<Styled, "text"> = {}): DetailLine => [{ text, ...style }];
const muted = (text: string) => plain(text, { color: color.muted });
const heading = (text: string): DetailLine => plain(text, { bold: true, color: color.accent });
// Multi-line text (task detail, agent messages) becomes one detail line per source line.
const block = (text: string, style: Omit<Styled, "text"> = {}) => clean(text).split("\n").map((l) => plain(l, style));

const PICK = "Select an item with j or k.";

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
  if (!task) return [muted(view.tasks.length ? PICK : "Pick a task in [2] to see its detail.")];
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
  if (!approval) return [muted(view.approvals.length + view.proposals.length ? PICK : "Nothing needs you right now.")];
  const space = view.state.spaces.find((s) => s.id === approval.spaceId);
  const review = reviewLine(approval, view.state, messages);
  const owner = approval.spaceId === null ? "Atrium" : (space?.name ?? "Unknown space");
  const lines: DetailLine[] = [muted(owner), plain(approval.title, { bold: true })];
  if (review) lines.push(plain(review.text, { color: review.tone ? TONE[review.tone] : undefined }));
  lines.push(blank, ...block(approval.detail || "No further detail."), blank);
  lines.push(muted(`Asked ${relative(approval.createdAt)} (${absolute(approval.createdAt)})`));
  if (approval.alwaysAsk === "create_repo") lines.push(plain("Edit the fields in the dashboard. a approves them as shown."));
  lines.push(
    muted(
      approval.kind === "alert"
        ? "a dismiss · turn the alert off or change it on the dashboard"
        : approval.spaceId === null
          ? "a approve · r decline"
          : "a approve · r send back · enter on the task in [2] for runs · t transcript",
    ),
  );
  return lines;
}

export function proposalDetail(view: View): DetailLine[] {
  const p = view.proposal;
  if (!p) return [muted(PICK)];
  const space = view.state.spaces.find((s) => s.id === p.spaceId)?.name ?? "this space";
  return [
    muted(space),
    plain(`Stop asking about ${p.label}?`, { bold: true }),
    plain(`You approved the last ${p.evidence.length} without changes.`),
    blank,
    // The dashboard's wording, so both front-ends promise the same thing.
    plain(
      `If you say yes, Atrium approves these in ${space} on its own from now on. It never merges or pushes, each one shows up in Activity, and you can undo any of them or turn the rule off on the dashboard's Rules page. It still always asks before merging, deploying, deleting, messaging someone new, spending money, or touching secrets.`,
      { color: color.muted },
    ),
    blank,
    heading("Approved without changes"),
    ...p.evidence.map((e): DetailLine => [{ text: `${relative(e.resolvedAt)}  `, color: color.muted }, { text: e.title }]),
    blank,
    muted("y yes · n not now · N never"),
  ];
}

// The engine logs a rule's decision as Atrium's, in these words; it's the only record of it the state carries.
export const ruleApproved = (row: State["activity"][number]) => row.message.startsWith("Approved by your rule");

export function spaceDetail(view: View, reviewers: Record<string, string | null> | null, markets: MarketsGlance | null = null): DetailLine[] {
  const space = view.space;
  if (!space) return [muted(view.spaces.length ? PICK : "No spaces yet. Press N to describe one.")];
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
  if (space.kind === "markets") {
    lines.push(blank);
    if (markets) {
      lines.push(plain(`Watching ${plural(markets.watchlist, "symbol")}`));
      if (markets.paper) lines.push(plain(`Paper ${signedMoney(markets.paper.dayPnl)} today (${signedMoney(markets.paper.totalPnl)} total)`));
    }
    lines.push(muted("Open the dashboard for charts, alerts and the paper account."));
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
  if (!row) return [muted(view.activity.length ? PICK : "No activity yet. Agent runs and your decisions will show up here.")];
  const space = row.spaceId ? view.state.spaces.find((s) => s.id === row.spaceId) : undefined;
  const byRule = ruleApproved(row);
  return [
    [{ text: byRule ? "Your rule" : actorName(row.actor), bold: true }, ...(space ? [{ text: ` · ${space.name}`, color: color.info }] : [])],
    muted(absolute(row.createdAt)),
    blank,
    ...block(row.message),
    ...(byRule
      ? [blank, plain("This was approved by your rule, not by you. Undo it, or turn the rule off, on the dashboard's Rules page.", { color: color.info })]
      : []),
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
