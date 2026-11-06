// What the Detail pane says about the selected thing, as styled lines. Pure, so it's tested without a terminal.
import { agentName, agentText, needsAction, verdictOf, waitOf } from "../dashboard/agents";
import { absolute, clock, duration, relative, tokens } from "../dashboard/format";
import { actorName, reviewHint, reviewLine, runOutcome, spaceStatus, STATUS_TEXT } from "../dashboard/summary";
import { type ActivityGroup, type ActivityTone, byDay, groupActivity, leadOf, visibleGroups } from "../engine/activity-groups";
import type { Message } from "../engine/messages";
import type { TaskOutputs } from "../engine/outputs/views";
import type { State } from "../engine/state";
import { money } from "../engine/markets/labels";
import { displayHandle } from "../engine/messaging/rules";
import { outcomeText } from "../engine/outcome";
import { fileSize, plural } from "../engine/text";
import type { MarketsGlance } from "./client";
import { markdownLines } from "./markdown";
import type { View } from "./select";
import { clean, width } from "./text";
import { type AnsiColor, color, STATUS_GLYPH } from "./theme";

type Run = State["runs"][number];

export type Styled = { text: string; color?: AnsiColor; bold?: boolean; dim?: boolean };
export type DetailLine = Styled[];

const SPACE_ACTIVITY = 5;

// How a feed line's time reads in a narrow column: "5m" today, "Yest", then "Nov 3".
export function groupWhen(g: ActivityGroup, now = Date.now()): string {
  if (g.day === "Today") return relative(g.at, now).replace(" ago", "").replace("just now", "now");
  if (g.day === "Yesterday") return "Yest";
  return new Date(g.at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export const TONE_COLOR: Record<ActivityTone, AnsiColor | undefined> = { routine: undefined, attention: color.warn, failure: color.bad, notice: color.ok };
const TONE = { ok: color.ok, waiting: color.warn, bad: color.bad } as const;

const blank: DetailLine = [];
const signedMoney = (n: number) => `${n >= 0 ? "+" : "−"}${money(Math.abs(n), "USD")}`;
const signedCad = (n: number) => `${n >= 0 ? "+" : "−"}CA$${Math.round(Math.abs(n)).toLocaleString("en-US")}`;
const signedPct1 = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(1)}%`;
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

const CHIP = { created: "new", changed: "changed", deleted: "deleted" } as const;

function decided(s: NonNullable<TaskOutputs["summary"]>): string {
  if (s.status === "pending") return "Waiting for you";
  if (s.status === "rejected") return `Sent back ${relative(s.at)}`;
  if (s.outcome === "couldnt") return `Accepted anyway by you ${relative(s.at)}`;
  if (s.outcome === "partial") return `Accepted as is by you ${relative(s.at)}`;
  return `${s.decidedBy === "rule" ? "Approved by your rule" : "Approved by you"} ${relative(s.at)}`;
}

// The summary and the files a task made, the terminal's version of the dashboard's "What it made".
function made(outputs: TaskOutputs | null, selected: number | null, width: number): DetailLine[] {
  if (!outputs || (!outputs.summary && outputs.files.length === 0)) return [];
  const lines: DetailLine[] = [];
  if (outputs.summary) lines.push(heading("Summary"), ...markdownLines(outputs.summary.text, width), muted(decided(outputs.summary)), blank);
  lines.push(heading("What it made"));
  if (outputs.files.length === 0) return [...lines, muted("No files. This run answered in text only."), blank];
  outputs.files.forEach((f, i) => {
    const mark = i === selected ? "▸ " : "  ";
    const gone = !f.exists || f.change === "deleted";
    const amount = f.insertions !== null || f.deletions !== null ? `+${f.insertions ?? 0} −${f.deletions ?? 0}` : f.size !== null ? fileSize(f.size) : "";
    lines.push([
      { text: `${mark}${f.path}`, bold: i === selected, color: gone ? color.muted : undefined },
      { text: gone ? "  no longer in the folder" : `  ${CHIP[f.change]}${amount ? `  ${amount}` : ""}`, color: color.muted },
    ]);
  });
  return [...lines, muted("f select a file · o open · R reveal in Finder"), blank];
}

function thread(messages: Message[] | null, width = 100): DetailLine[] {
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
      return [head, ...markdownLines(m.body, width)];
    }),
  ];
}

export function taskDetail(view: View, messages: Message[] | null, outputs: TaskOutputs | null = null, selectedFile: number | null = null, width = 100): DetailLine[] {
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
  const told = outcomeText(task.outcome, task.outcomeReason);
  if (told && (task.status === "review" || task.status === "done")) lines.push(plain(told, { color: task.outcome === "unknown" ? color.muted : color.warn }));
  // Wait reasons can name a command in backticks; they're kept as written so it can be copied.
  if (wait) lines.push(plain(wait.reason, { color: needsAction(wait) ? color.bad : color.warn }));
  if (parent) {
    lines.push(muted(`${task.kind === "review" ? "Reviews" : "Fixes what the review found in"} "${parent.title}"`));
  }
  lines.push(blank, ...block(task.detail || task.title), blank, ...made(outputs, selectedFile, width));
  lines.push(
    [{ text: "Agent ", color: color.muted }, { text: agentText(task, state.runs) }],
    muted(`Added ${relative(task.createdAt)} (${absolute(task.createdAt)}) · Updated ${relative(task.updatedAt)}`),
  );
  if (task.branch) lines.push(muted(`Branch ${task.branch}`));
  lines.push(muted(task.weight === "heavy" ? "Heavy · runs when plugged in" : "Light · runs anytime"));
  if (task.ignoreReserve) lines.push(muted("Runs during Claude's reserve"));
  if (task.kind === "work") lines.push(...thread(messages, width));
  lines.push(blank, heading("Runs"));
  if (runs.length === 0) lines.push(muted("No runs yet."));
  else lines.push(...runs.map(runRow), muted("t transcript · [ ] older / newer run"));
  return lines;
}

function messageLines(m: State["messageActions"][number]): DetailLine[] {
  const lines: DetailLine[] = [];
  if (m.lastError) lines.push(blank, plain(`Last try failed: ${m.lastError}`, { color: color.bad }));
  lines.push(
    blank,
    [{ text: "To   ", color: color.muted }, { text: m.toName, bold: true }, { text: m.handle ? `  ${displayHandle(m.handle)}` : "  number needed", color: m.handle ? undefined : color.warn }],
    [{ text: "Via  ", color: color.muted }, { text: m.service }],
    blank,
    ...block(m.text),
    blank,
    muted("Sends from Messages on this Mac. Atrium can't confirm delivery."),
    muted(m.handle ? "a send · r don't send" : "Pick who this goes to on the dashboard, then a sends it here · r don't send"),
  );
  return lines;
}

export function approvalDetail(view: View, messages: Message[] | null, width = 100): DetailLine[] {
  const approval = view.approval;
  if (!approval) return [muted(view.approvals.length + view.proposals.length ? PICK : "Nothing needs you right now.")];
  const space = view.state.spaces.find((s) => s.id === approval.spaceId);
  const review = reviewLine(approval, view.state, messages);
  const owner = approval.spaceId === null ? "Atrium" : (space?.name ?? "Unknown space");
  const lines: DetailLine[] = [muted(owner), plain(approval.title, { bold: true })];
  const text = approval.alwaysAsk === "send_message" ? view.state.messageActions.find((m) => m.approvalId === approval.id) : undefined;
  if (text) return [...lines, ...messageLines(text), blank, muted(`Asked ${relative(approval.createdAt)} (${absolute(approval.createdAt)})`)];
  const task = approval.kind === "review" && approval.taskId ? view.state.tasks.find((t) => t.id === approval.taskId) : undefined;
  const told = task ? outcomeText(task.outcome, task.outcomeReason) : null;
  if (told) lines.push(plain(told, { color: task?.outcome === "unknown" ? color.muted : color.warn }));
  if (review) lines.push(plain(review.text, { color: review.tone ? TONE[review.tone] : undefined }));
  lines.push(blank, ...(approval.detail ? markdownLines(approval.detail, width) : [plain("No further detail.")]), blank);
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

const cadWhole = (n: number) => `CA$${Math.round(n).toLocaleString("en-US")}`;
const priceText = (n: number, ccy: "CAD" | "USD") => `${ccy === "USD" ? "US$" : "CA$"}${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dayFmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
const hourText = (h: string | null) => (h === "bmo" ? "before open" : h === "amc" ? "after close" : "time not set");

// The investing glance: the portfolio's value and day, each list with symbols padded and prices right-aligned, and
// the next two weeks of earnings.
function marketsLines(g: MarketsGlance): DetailLine[] {
  const out: DetailLine[] = [];
  const p = g.portfolio;
  if (p && p.totalCad !== null) {
    const day = p.dayPct !== null && p.dayCad !== null ? ` · ${signedPct1(p.dayPct)} ${p.dayLabel ?? "today"} (${signedCad(p.dayCad)})` : "";
    out.push(plain(`Portfolio ${cadWhole(p.totalCad)}${day}`));
    if (p.mix) out.push(muted(p.mix));
  } else out.push(plain("No holdings yet. Import them in the app."));
  if (g.paper) out.push(plain(`Paper ${signedMoney(g.paper.dayPnl)} today (${signedMoney(g.paper.totalPnl)} total)`));
  for (const l of g.lists) {
    out.push(blank, heading(l.name));
    if (!l.rows.length) {
      out.push(muted("  Nothing here yet."));
      continue;
    }
    const sym = Math.max(...l.rows.map((r) => r.key.length));
    const prices = l.rows.map((r) => (r.price === null ? "no price" : priceText(r.price, r.ccy)));
    const width = Math.max(...prices.map((x) => x.length));
    l.rows.forEach((r, i) => {
      const line: DetailLine = [{ text: `  ${r.key.padEnd(sym)}  ${prices[i]!.padStart(width)}${r.dayPct === null ? "" : `  ${signedPct1(r.dayPct)}`}` }];
      if (r.tag) line.push({ text: `  ${r.tag}`, color: color.muted });
      out.push(line);
    });
  }
  out.push(blank, heading("Earnings in the next 2 weeks"));
  if (!g.earnings.length) out.push(muted("No earnings in the next two weeks."));
  for (const e of g.earnings) {
    const when = dayFmt.format(Date.parse(`${e.date}T12:00:00Z`));
    const line: DetailLine = [{ text: `  ${when}  ${e.key}  ${hourText(e.hour)}` }];
    if (e.held) line.push({ text: "  · you hold this", color: color.muted });
    out.push(line);
  }
  return out;
}

export function spaceDetail(view: View, reviewers: Record<string, string | null> | null, markets: MarketsGlance | null = null): DetailLine[] {
  const space = view.space;
  if (!space) return [muted(view.spaces.length ? PICK : "No spaces yet. Press N to describe one.")];
  const { state } = view;
  if (space.status === "archived") {
    return [
      [{ text: space.name, bold: true }, { text: `  ${space.kind}  archived`, color: color.muted }],
      plain(space.goal || "No goal."),
      blank,
      plain("Archived spaces don't pick up tasks."),
      muted("X restores it · D deletes it for good"),
    ];
  }
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
    if (markets) lines.push(...marketsLines(markets));
    lines.push(muted("Open the app for the chart."));
  }
  // Failures and lines waiting on Nakul always show, past the newest few.
  const { visible: groups } = visibleGroups(
    groupActivity(state.activity.filter((a) => a.spaceId === space.id), { tasks: state.tasks, files: state.activityFiles }),
    SPACE_ACTIVITY,
  );
  lines.push(blank, heading("Recent activity"));
  if (groups.length === 0) lines.push(muted("Nothing yet."));
  for (const day of byDay(groups)) {
    lines.push(muted(day.day));
    for (const g of day.groups) {
      const lead = leadOf(g);
      lines.push([{ text: `  ${clock(g.at)}  `, color: color.muted }, { text: lead ? `${lead} · ${g.text}` : g.text, color: TONE_COLOR[g.tone] }]);
    }
  }
  return lines;
}

export function activityDetail(view: View): DetailLine[] {
  const g = view.activityRow;
  if (!g) return [muted(view.activity.length ? PICK : "No activity yet. Agent runs and your decisions will show up here.")];
  const space = g.spaceId ? view.state.spaces.find((s) => s.id === g.spaceId) : undefined;
  const lead = leadOf(g);
  const byRule = g.events.some(ruleApproved);
  const first = g.events.at(-1)!;
  const span = g.events.length > 1 ? `${g.day} · ${clock(first.createdAt)} to ${clock(g.at)}` : `${g.day} · ${clock(g.at)}`;
  return [
    [{ text: lead ?? (g.title ? g.title : actorName(g.actor)), bold: true }, ...(space ? [{ text: ` · ${space.name}`, color: color.info }] : [])],
    muted(span),
    blank,
    [{ text: g.text, color: TONE_COLOR[g.tone] }],
    blank,
    heading(g.events.length > 1 ? `All ${g.events.length} lines` : "The line"),
    ...g.events.flatMap((e): DetailLine[] => [
      [{ text: `${clock(e.createdAt)}  `, color: color.muted }, { text: `${ruleApproved(e) ? "Your rule" : actorName(e.actor)}: `, color: color.info }, { text: e.message }],
    ]),
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
