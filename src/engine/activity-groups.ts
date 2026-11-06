// Turns the activity log into a short, calm feed: one line per task per stretch of routine work, repeated system
// lines folded with a count, failures and things waiting on Nakul kept on their own lines. Pure, so the dashboard
// and the terminal app show the same feed.
import type { ActivityRow } from "./events";

export type ActivityKind =
  | "started"
  | "finished"
  | "ready"
  | "drafted"
  | "decided"
  | "rule"
  | "skipped"
  | "requeued"
  | "paused"
  | "partial"
  | "couldnt"
  | "blocked"
  | "failed"
  | "alert"
  | "sent"
  | "paper"
  | "other";

// routine: folds away; attention: waiting on Nakul; failure: something went wrong; notice: worth its own line.
export type ActivityTone = "routine" | "attention" | "failure" | "notice";

export type ActivityGroup = {
  // The newest event's id, so a group keeps its identity while older lines join it.
  id: string;
  day: string;
  dayKey: string;
  at: number;
  spaceId: string | null;
  taskId: string | null;
  // The task the line is about, when there is one.
  title: string | null;
  tone: ActivityTone;
  text: string;
  count: number;
  actor: string;
  // Newest first.
  events: ActivityRow[];
};

export type ActivityContext = {
  now?: number;
  tasks?: { id: string; title: string; status: string }[];
  // Files each task's runs made, by task id.
  files?: Record<string, number>;
};

// How many groups a feed shows before "Show more", and how many each press adds.
export const ACTIVITY_PAGE = 5;
export const ACTIVITY_MORE = 10;

// Checked in order; each pattern is the start of a line the engine writes (see the logActivity calls).
const KINDS: [RegExp, ActivityKind][] = [
  [/^Started: /, "started"],
  [/^Finished: /, "finished"],
  [/^Ready for review: /, "ready"],
  [/^Drafted a text to /, "drafted"],
  [/^Approved by your rule /, "rule"],
  [/^(Approved|Rejected|Accepted anyway|Accepted as is|Pressed Send|Chose not to send|Dismissed): /, "decided"],
  [/^Skipped: /, "skipped"],
  [/^The engine (stopped|restarted), so /, "requeued"],
  [/^Paused: /, "paused"],
  [/^Partly done: /, "partial"],
  [/^Couldn't do: /, "couldnt"],
  [/^Blocked: /, "blocked"],
  [/^(Couldn't |Didn't send|Atrium hit a problem|Discarded the result|Kept the local copy)/, "failed"],
  [/^Alert: /, "alert"],
  [/^Sent via Messages to /, "sent"],
  [/^Paper (buy|sell) /, "paper"],
];

export function activityKind(message: string): ActivityKind {
  return KINDS.find(([re]) => re.test(message))?.[1] ?? "other";
}

const OWN_LINE: Partial<Record<ActivityKind, ActivityTone>> = {
  partial: "attention",
  couldnt: "failure",
  blocked: "failure",
  failed: "failure",
  sent: "notice",
};

// The task a line names, for lines logged before activity recorded task ids.
function titleIn(kind: ActivityKind, message: string): string | null {
  const after = (re: RegExp) => message.replace(re, "");
  switch (kind) {
    case "started":
    case "finished":
    case "ready":
      return after(/^[^:]+: /);
    case "decided":
      return after(/^[^:]+: /).replace(/\. It says .*$/, "");
    case "rule":
      return after(/^Approved by your rule ".*?": /);
    case "drafted":
      return after(/^Drafted a text to [^:]+: /);
    case "skipped":
      return message.startsWith("Skipped: you already decided. ") ? after(/^Skipped: you already decided\. /) : null;
    case "requeued":
      return message.match(/^The engine (?:stopped|restarted), so (.+?) is back in the queue\./)?.[1] ?? null;
    default:
      return null;
  }
}

const dayKeyOf = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function dayLabel(t: number, now = Date.now()): string {
  const key = dayKeyOf(t);
  if (key === dayKeyOf(now)) return "Today";
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (key === dayKeyOf(y.getTime())) return "Yesterday";
  const d = new Date(t);
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== new Date(now).getFullYear() && { year: "numeric" }),
  });
}

const PHRASE: Partial<Record<ActivityKind, (message: string) => string>> = {
  ready: () => "ready for review",
  drafted: () => "drafted a text",
  rule: () => "approved by your rule",
  skipped: () => "review skipped",
  requeued: () => "back in the queue",
  paused: () => "paused for a usage limit",
  decided: (m) =>
    m.startsWith("Rejected")
      ? "sent back"
      : m.startsWith("Accepted anyway")
        ? "accepted anyway"
        : m.startsWith("Accepted as is")
          ? "accepted as is"
          : m.startsWith("Pressed Send")
            ? "pressed Send"
            : m.startsWith("Chose not to send")
              ? "chose not to send"
              : m.startsWith("Dismissed")
                ? "dismissed"
                : "approved",
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// One task's routine stretch as a short phrase list: "ran, wrote 2 files, waiting for review".
function taskText(events: ActivityRow[], status: string | undefined, files: number): { text: string; waiting: boolean } {
  const chrono = [...events].reverse();
  const kinds = chrono.map((e) => activityKind(e.message));
  const starts = kinds.filter((k) => k === "started").length;
  const ended = kinds.some((k) => k === "finished" || k === "ready" || k === "drafted");
  const runs = starts || (ended ? 1 : 0);
  const phrases: string[] = [];
  const last = kinds.at(-1);
  if (runs) {
    if (last === "started" && status === "running") phrases.push("running");
    else if (!ended && runs === 1) phrases.push("started");
    else phrases.push(runs === 1 ? "ran" : `ran ${runs} times`);
  }
  if (files > 0 && ended) phrases.push(`wrote ${plural(files, "file")}`);
  chrono.forEach((e, i) => {
    const phrase = PHRASE[kinds[i]!]?.(e.message);
    if (phrase && phrases.at(-1) !== phrase) phrases.push(phrase);
  });
  let waiting = false;
  if (status === "review" && (last === "ready" || last === "drafted")) {
    waiting = true;
    phrases[phrases.length - 1] = last === "ready" ? "waiting for review" : "waiting for you to press Send";
  }
  return { text: phrases.join(", "), waiting };
}

type Building = { events: ActivityRow[]; key: string; kind: "task" | "fold" | "own" };

export function groupActivity(rows: ActivityRow[], ctx: ActivityContext = {}): ActivityGroup[] {
  const now = ctx.now ?? Date.now();
  const tasks = new Map((ctx.tasks ?? []).map((t) => [t.id, t]));
  const byDayKey = new Map<string, ActivityRow[]>();
  for (const r of rows) {
    const k = dayKeyOf(r.createdAt);
    byDayKey.set(k, [...(byDayKey.get(k) ?? []), r]);
  }
  const out: ActivityGroup[] = [];
  // Files are said once, on the task's newest line.
  const filesSaid = new Set<string>();
  for (const [dayKey, dayRows] of byDayKey) {
    const built: Building[] = [];
    const open = new Map<string, Building>();
    // Oldest first, so a failure closes the stretch before it and the next line starts a new one.
    const chrono = [...dayRows].sort((a, b) => a.createdAt - b.createdAt);
    for (const r of chrono) {
      const kind = activityKind(r.message);
      const title = r.taskId ? (tasks.get(r.taskId)?.title ?? titleIn(kind, r.message)) : titleIn(kind, r.message);
      const taskKey = r.taskId ? `id:${r.taskId}` : title ? `title:${r.spaceId}:${title}` : null;
      if (OWN_LINE[kind]) {
        if (taskKey) open.delete(taskKey);
        built.push({ events: [r], key: "", kind: "own" });
        continue;
      }
      if (taskKey && kind !== "alert" && kind !== "paper" && kind !== "other") {
        const cur = open.get(taskKey);
        if (cur) cur.events.unshift(r);
        else {
          const b: Building = { events: [r], key: taskKey, kind: "task" };
          open.set(taskKey, b);
          built.push(b);
        }
        continue;
      }
      const foldKey = `fold:${r.spaceId}:${kind === "paper" ? "paper" : r.message}`;
      const cur = open.get(foldKey);
      if (cur) cur.events.unshift(r);
      else {
        const b: Building = { events: [r], key: foldKey, kind: "fold" };
        open.set(foldKey, b);
        built.push(b);
      }
    }
    // Newest stretch first, so a task's files are said on its latest line.
    for (const b of [...built].reverse()) {
      const newest = b.events[0]!;
      const kind = activityKind(newest.message);
      const taskId = b.events.find((e) => e.taskId)?.taskId ?? null;
      const task = taskId ? tasks.get(taskId) : undefined;
      const title = task?.title ?? b.events.map((e) => titleIn(activityKind(e.message), e.message)).find((t) => t) ?? null;
      const base = { id: newest.id, day: dayLabel(newest.createdAt, now), dayKey, at: newest.createdAt, spaceId: newest.spaceId, taskId, title, count: b.events.length, actor: newest.actor, events: b.events };
      if (b.kind === "own") out.push({ ...base, tone: OWN_LINE[kind]!, text: newest.message });
      else if (b.kind === "task") {
        const filesKey = b.key;
        const files = taskId && !filesSaid.has(filesKey) ? (ctx.files?.[taskId] ?? 0) : 0;
        filesSaid.add(filesKey);
        const { text, waiting } = taskText(b.events, task?.status, files);
        out.push({ ...base, tone: waiting ? "attention" : "routine", text });
      } else {
        const n = b.events.length;
        const text = n === 1 ? newest.message : kind === "paper" ? `${n} paper trades` : `${newest.message} ×${n}`;
        out.push({ ...base, tone: kind === "alert" ? "attention" : "routine", text });
      }
    }
  }
  // Newest line first; groups from one millisecond keep the order their newest rows had in the feed.
  const order = new Map(rows.map((r, i) => [r.id, i]));
  return out.sort((a, b) => b.at - a.at || order.get(a.id)! - order.get(b.id)!);
}

export function byDay(groups: ActivityGroup[]): { day: string; dayKey: string; groups: ActivityGroup[] }[] {
  const days: { day: string; dayKey: string; groups: ActivityGroup[] }[] = [];
  for (const g of groups) {
    const last = days.at(-1);
    if (last?.dayKey === g.dayKey) last.groups.push(g);
    else days.push({ day: g.day, dayKey: g.dayKey, groups: [g] });
  }
  return days;
}
