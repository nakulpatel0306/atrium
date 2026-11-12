import type { EventView, MessageView, ThreadView } from "../engine/mail/store";
import type { Person } from "../engine/mail/types";
import type { MailOverview } from "../server/mail";
import { useEngineState, useFetched } from "./api";

export type { EventView, MailOverview, MessageView, ThreadView };
export type ThreadDetail = { thread: ThreadView; messages: MessageView[]; problem: string | null };
export type InboxFilter = "all" | "unread" | "needs_reply";

// Everything here is read again on each engine change, so a finished sync shows up without a reload.
export const useMailOverview = () => useFetched<MailOverview>("/api/mail", useEngineState());

export function useThreads(account: string | null, filter: InboxFilter): ThreadView[] | null {
  const q = new URLSearchParams();
  if (account) q.set("account", account);
  if (filter !== "all") q.set("filter", filter);
  return useFetched<{ threads: ThreadView[] }>(`/api/mail/threads?${q}`, useEngineState())?.threads ?? null;
}

export const useThread = (id: string | null) => useFetched<ThreadDetail>(id ? `/api/mail/threads/${encodeURIComponent(id)}` : null, useEngineState());

export const useEvents = (from: number, to: number) => useFetched<{ events: EventView[] }>(`/api/mail/events?from=${from}&to=${to}`, useEngineState())?.events ?? null;

export const personName = (p: Person): string => p.name || p.address || "Unknown";

// "Robin, Kit +2" for a list row.
export function peopleLine(people: Person[], max = 2): string {
  if (!people.length) return "Only you";
  const names = people.map((p) => (p.name ? p.name.split(/\s+/)[0]! : p.address.split("@")[0]!));
  return names.length > max ? `${names.slice(0, max).join(", ")} +${names.length - max}` : names.join(", ");
}

// Today shows the time, this week the weekday, older the date.
export function shortWhen(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const n = new Date(now);
  if (d.toDateString() === n.toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (now - ts < 6 * 86_400_000) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

// A body split where quoted history starts: the first "On … wrote:" line, or the first run of "> " lines that
// carries on to the end. The quoted part is folded in the thread view.
export function splitQuoted(text: string): { body: string; quoted: string | null } {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const wrote = /^\s*On .{4,200}wrote:\s*$/.test(l) || /^-{2,}\s*(Original Message|Forwarded message)\s*-{2,}/i.test(l);
    const quoteRun = l.startsWith(">") && lines.slice(i).every((x) => x.startsWith(">") || !x.trim());
    if (i > 0 && (wrote || quoteRun)) {
      const body = lines.slice(0, i).join("\n").trimEnd();
      if (body.trim()) return { body, quoted: lines.slice(i).join("\n").trim() };
    }
  }
  return { body: text, quoted: null };
}

export const DAY_MS = 86_400_000;
export const startOfDay = (ts: number): number => {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
// Monday of ts's week, local time.
export const startOfWeek = (ts: number): number => {
  const d = new Date(startOfDay(ts));
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
};
export const addDays = (ts: number, n: number): number => {
  const d = new Date(ts);
  d.setDate(d.getDate() + n);
  return d.getTime();
};

// Agenda groups: today, tomorrow, then the rest of the next seven days by day.
export function agenda(events: EventView[], now = Date.now()): { label: string; day: number; events: EventView[] }[] {
  const today = startOfDay(now);
  const groups: { label: string; day: number; events: EventView[] }[] = [];
  for (let i = 0; i < 7; i++) {
    const day = addDays(today, i);
    const next = addDays(today, i + 1);
    const list = events.filter((e) => e.start < next && e.end > day && (i > 0 || e.allDay || e.end > now - 3600_000));
    if (!list.length && i > 1) continue;
    const label = i === 0 ? "Today" : i === 1 ? "Tomorrow" : new Date(day).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
    groups.push({ label, day, events: list });
  }
  return groups;
}

export type Placed = { event: EventView; col: number; cols: number };

// One day's timed events, laid out side by side where they overlap: each cluster of overlapping events shares its
// width equally, and an event takes the first column free at its start.
export function placeDay(events: EventView[]): Placed[] {
  const timed = events.filter((e) => !e.allDay).sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Placed[] = [];
  let cluster: Placed[] = [];
  let clusterEnd = -Infinity;
  const close = () => {
    const cols = Math.max(1, ...cluster.map((p) => p.col + 1));
    for (const p of cluster) p.cols = cols;
    out.push(...cluster);
    cluster = [];
  };
  for (const e of timed) {
    if (e.start >= clusterEnd && cluster.length) close();
    const used = new Set(cluster.filter((p) => p.event.end > e.start).map((p) => p.col));
    let col = 0;
    while (used.has(col)) col++;
    cluster.push({ event: e, col, cols: 1 });
    clusterEnd = Math.max(clusterEnd, e.end);
  }
  if (cluster.length) close();
  return out;
}

export const overlaps = (events: EventView[]): Set<string> => {
  const ids = new Set<string>();
  const timed = events.filter((e) => !e.allDay);
  for (const a of timed) for (const b of timed) if (a.id !== b.id && a.start < b.end && b.start < a.end) ids.add(a.id);
  return ids;
};

export const sourceLabel = (s: "google" | "apple"): string => (s === "google" ? "Google" : "Mail.app");
