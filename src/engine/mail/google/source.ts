import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../../config";
import { parseAddressList, parseIds, parsePerson } from "../addresses";
import { buildMime } from "../mime";
import { MailProblem, type AccountRef, type AttendeeStatus, type MailSource, type Outgoing, type SourceAttachment, type SourceEvent, type SourceMessage } from "../types";
import { type GoogleAuth, signedOutCopy } from "./oauth";
import { safeFileName } from "../files";
import { canonicalRecurrence } from "../recurrence";

const HTTP_TIMEOUT_MS = 20_000;
const WRITE_TIMEOUT_MS = 60_000;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const UNSURE_COPY = "This may have gone out: Google's answer didn't say. Check Gmail's Sent mail or Google Calendar before sending it again.";
const NOT_CONNECTED = new Set(["ConnectionRefused", "FailedToOpenSocket", "ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH"]);
const MAX_THREAD_PAGES = 5;
const MAX_EVENT_PAGES = 10;
const PARALLEL = 5;
const HEADERS = ["From", "To", "Cc", "Subject", "Date", "Message-ID", "In-Reply-To", "References"];
const DAY_MS = 86_400_000;

type GHeader = { name: string; value: string };
type GPart = { mimeType?: string; filename?: string; headers?: GHeader[]; body?: { data?: string; size?: number; attachmentId?: string }; parts?: GPart[] };
type GMessage = { id: string; threadId: string; labelIds?: string[]; snippet?: string; internalDate?: string; payload?: GPart };

const header = (p: GPart | undefined, name: string) => p?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;
// A part's text in its own charset (Content-Type's charset=…); UTF-8 when it names none or one the runtime lacks.
function decode(data: string, part: GPart): string {
  const bytes = Buffer.from(data, "base64url");
  const charset = /charset="?([^";\s]+)/i.exec(header(part, "Content-Type") ?? "")?.[1];
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

// Gmail's snippet is HTML-escaped.
const unescape = (s: string) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

export function toSourceMessage(m: GMessage): SourceMessage {
  const p = m.payload;
  const messageId = parseIds(header(p, "Message-ID"))[0] ?? null;
  return {
    sourceId: m.id,
    threadKey: m.threadId,
    messageId,
    inReplyTo: parseIds(header(p, "In-Reply-To"))[0] ?? null,
    references: parseIds(header(p, "References")),
    subject: header(p, "Subject") ?? "",
    from: parsePerson(header(p, "From")),
    to: parseAddressList(header(p, "To")),
    cc: parseAddressList(header(p, "Cc")),
    date: Number(m.internalDate) || Date.parse(header(p, "Date") ?? "") || 0,
    snippet: unescape(m.snippet ?? ""),
    unread: m.labelIds?.includes("UNREAD") ?? false,
    sent: m.labelIds?.includes("SENT") ?? false,
    labels: m.labelIds ?? [],
    attachments: attachmentsOf(p),
  };
}

function attachmentsOf(p: GPart | undefined): SourceAttachment[] {
  const out: SourceAttachment[] = [];
  const walk = (part: GPart | undefined) => {
    if (!part) return;
    if (part.filename && part.body?.attachmentId) out.push({ name: part.filename, size: part.body.size ?? 0, ref: part.body.attachmentId });
    part.parts?.forEach(walk);
  };
  walk(p);
  return out;
}

function textParts(p: GPart | undefined): { text: string | null; html: string | null; icalUid: string | null } {
  let text: string | null = null;
  let html: string | null = null;
  let icalUid: string | null = null;
  const walk = (part: GPart | undefined) => {
    if (!part || part.filename) return;
    if (part.mimeType === "text/plain" && part.body?.data && text === null) text = decode(part.body.data, part);
    if (part.mimeType === "text/html" && part.body?.data && html === null) html = decode(part.body.data, part);
    if (part.mimeType === "text/calendar" && part.body?.data && icalUid === null) icalUid = calendarUid(decode(part.body.data, part));
    part.parts?.forEach(walk);
  };
  walk(p);
  return { text, html, icalUid };
}

// The UID line of an invitation's iCalendar text, with folded lines joined (RFC 5545 3.1).
export function calendarUid(ics: string): string | null {
  const uid = /^UID:(.+)$/m.exec(ics.replace(/\r?\n[ \t]/g, ""))?.[1]?.trim();
  return uid || null;
}

async function inBatches<T, R>(items: T[], fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += PARALLEL) out.push(...(await Promise.all(items.slice(i, i + PARALLEL).map(fn))));
  return out;
}

const STATUS: Record<string, AttendeeStatus> = { accepted: "accepted", declined: "declined", tentative: "tentative", needsAction: "needs_action" };
type GTime = { dateTime?: string; date?: string };
type GEvent = {
  id: string;
  iCalUID?: string;
  status?: string;
  summary?: string;
  location?: string;
  start?: GTime;
  end?: GTime;
  originalStartTime?: GTime;
  recurringEventId?: string;
  recurrence?: string[];
  organizer?: { email?: string };
  attendees?: { email?: string; displayName?: string; responseStatus?: string; self?: boolean }[];
};

const localDate = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
// Google's start and end: dates for an all-day event (the end date is the day after), else instants.
const gTimes = (start: number, end: number, allDay: boolean) =>
  allDay ? { start: { date: localDate(start) }, end: { date: localDate(end) } } : { start: { dateTime: new Date(start).toISOString() }, end: { dateTime: new Date(end).toISOString() } };

// An all-day date is that day's local midnight, so it lines up with the dashboard's local day columns.
const timeOf = (t: GTime | undefined): number => (t?.dateTime ? Date.parse(t.dateTime) : t?.date ? new Date(`${t.date}T00:00:00`).getTime() : 0);

export function toSourceEvent(e: GEvent): SourceEvent {
  const self = e.attendees?.find((a) => a.self);
  return {
    sourceId: e.id,
    icalUid: e.iCalUID ?? e.id,
    recurrenceId: canonicalRecurrence(e.originalStartTime?.dateTime ?? e.originalStartTime?.date),
    title: e.summary ?? "",
    start: timeOf(e.start),
    end: timeOf(e.end),
    allDay: !e.start?.dateTime,
    location: e.location ?? "",
    attendees: (e.attendees ?? []).map((a) => ({ name: a.displayName ?? "", address: (a.email ?? "").toLowerCase(), status: STATUS[a.responseStatus ?? ""] ?? null })),
    organizer: e.organizer?.email?.toLowerCase() ?? null,
    myStatus: self ? (STATUS[self.responseStatus ?? ""] ?? null) : null,
    recurrence: e.recurrence?.join("\n") ?? (e.recurringEventId ? `series:${e.recurringEventId}` : null),
  };
}

// Gmail and Google Calendar for one connected account at a time; tokens come from GoogleAuth.
export function googleSource(auth: GoogleAuth, deps: { fetch?: typeof fetch } = {}): MailSource {
  const http = deps.fetch ?? fetch;

  // A read, or with `write` a change. A 401 is refused before anything happens, so it's retried once with a fresh
  // token; nothing else is ever retried. A write that may have reached Google (no answer, or a server error) is
  // "unsure", so the user checks before trying again rather than Atrium sending twice.
  async function call<T>(account: AccountRef, url: string, write?: { method: string; body?: unknown }): Promise<T> {
    for (const force of [false, true]) {
      const token = await auth.accessToken(account.id, force);
      let res: Response;
      try {
        res = await http(url, {
          method: write?.method ?? "GET",
          headers: { authorization: `Bearer ${token}`, ...(write?.body !== undefined ? { "content-type": "application/json" } : {}) },
          body: write?.body !== undefined ? JSON.stringify(write.body) : undefined,
          signal: AbortSignal.timeout(write ? WRITE_TIMEOUT_MS : HTTP_TIMEOUT_MS),
        });
      } catch (e) {
        // Not connected at all means nothing was sent; anything after connecting (a timeout) may have been.
        if (write && !NOT_CONNECTED.has(String((e as { code?: unknown }).code))) throw new MailProblem("unsure", UNSURE_COPY);
        if (write) throw new MailProblem("offline", "Atrium couldn't reach Google, so nothing went out. Check the Mac is online, then try again.");
        throw new MailProblem("offline", "Atrium couldn't reach Google. Check the Mac is online; it tries again on the next sync.");
      }
      if (res.status === 401 && !force) continue;
      if (res.status === 401) throw new MailProblem("signed_out", signedOutCopy(account.address));
      if (res.status === 403) throw new MailProblem("other", `Google refused access to ${account.address}'s mail or calendar. Connect it again and allow every permission it asks for.`);
      if (write && res.status >= 500) throw new MailProblem("unsure", UNSURE_COPY);
      if (write && !res.ok) throw new MailProblem("other", "Google didn't accept this, so nothing went out. Check the card, then try again.");
      if (!res.ok) throw new MailProblem("other", "Google didn't answer properly. Atrium tries again on the next sync.");
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      try {
        return (text ? JSON.parse(text) : undefined) as T;
      } catch {
        // Google said yes in a form Atrium can't read: a write may well have gone through.
        if (write) throw new MailProblem("unsure", UNSURE_COPY);
        throw new MailProblem("other", "Google didn't answer properly. Atrium tries again on the next sync.");
      }
    }
    throw new MailProblem("signed_out", signedOutCopy(account.address));
  }
  const get = <T>(account: AccountRef, url: string) => call<T>(account, url);

  // Gmail's raw message, with the forwarded files read from where the engine saved them.
  function raw(m: Outgoing): string {
    const files = m.attachments.map((a) => ({ name: a.name, data: readFileSync(a.path) }));
    if (files.reduce((n, f) => n + f.data.length, 0) > MAX_ATTACHMENT_BYTES) throw new MailProblem("other", "The attachments are over Gmail's 25 MB limit, so nothing went out. Forward it from Gmail instead.");
    return Buffer.from(buildMime(m, files)).toString("base64url");
  }
  const calEvent = (calendarId: string, eventId?: string, q?: Record<string, string>) =>
    cal(`/calendars/${encodeURIComponent(calendarId)}/events${eventId ? `/${encodeURIComponent(eventId)}` : ""}${q ? `?${new URLSearchParams(q)}` : ""}`);
  const updates = (notify: boolean) => ({ sendUpdates: notify ? "all" : "none" });
  const need = (account: AccountRef | null): AccountRef => {
    if (!account) throw new MailProblem("other", "That calendar's Google account isn't connected anymore.");
    return account;
  };
  const gmail = (path: string) => `${config().google.gmailUrl}/gmail/v1/users/me${path}`;
  const cal = (path: string) => `${config().google.calendarUrl}/calendar/v3${path}`;

  return {
    kind: "google",

    async messages(account, since, known) {
      const days = Math.max(1, Math.ceil((Date.now() - since) / DAY_MS));
      const threads: { id: string; historyId: string }[] = [];
      let pageToken: string | undefined;
      for (let i = 0; i < MAX_THREAD_PAGES; i++) {
        const q = new URLSearchParams({ q: `newer_than:${days}d -in:spam -in:trash`, maxResults: "100", ...(pageToken ? { pageToken } : {}) });
        const page = await get<{ threads?: { id: string; historyId: string }[]; nextPageToken?: string }>(account, gmail(`/threads?${q}`));
        threads.push(...(page.threads ?? []));
        pageToken = page.nextPageToken;
        if (!pageToken) break;
      }
      const changed = threads.filter((t) => known(t.id) !== t.historyId);
      const meta = HEADERS.map((h) => `metadataHeaders=${encodeURIComponent(h)}`).join("&");
      const full = await inBatches(changed, (t) => get<{ messages?: GMessage[] }>(account, gmail(`/threads/${encodeURIComponent(t.id)}?format=metadata&${meta}`)));
      return {
        messages: full.flatMap((t) => (t.messages ?? []).map(toSourceMessage)).filter((m) => m.date >= since),
        versions: Object.fromEntries(changed.map((t) => [t.id, t.historyId])),
      };
    },

    async body(account, sourceId) {
      const m = await get<GMessage>(account, gmail(`/messages/${encodeURIComponent(sourceId)}?format=full`));
      return { ...textParts(m.payload), attachments: attachmentsOf(m.payload) };
    },

    async attachment(account, sourceId, att, dir) {
      const r = await get<{ data?: string }>(account, gmail(`/messages/${encodeURIComponent(sourceId)}/attachments/${encodeURIComponent(att.ref)}`));
      const path = join(dir, safeFileName(att.name));
      writeFileSync(path, Buffer.from(r.data ?? "", "base64url"));
      return path;
    },

    async calendars(account) {
      if (!account) return [];
      const r = await get<{ items?: { id: string; summary?: string; summaryOverride?: string; backgroundColor?: string; accessRole?: string; selected?: boolean }[] }>(account, cal("/users/me/calendarList"));
      return (r.items ?? [])
        .filter((c) => c.selected !== false)
        .map((c) => ({
          sourceId: c.id,
          title: c.summaryOverride ?? c.summary ?? c.id,
          color: /^#[0-9a-f]{6}$/i.test(c.backgroundColor ?? "") ? c.backgroundColor! : "#5e9fe0",
          writable: c.accessRole === "owner" || c.accessRole === "writer",
          accountAddress: account.address,
        }));
    },

    async send(account, m) {
      const r = await call<{ id?: string; threadId?: string }>(account, gmail("/messages/send"), { method: "POST", body: { raw: raw(m), ...(m.threadKey ? { threadId: m.threadKey } : {}) } });
      return { sourceId: r?.id ?? null, threadKey: r?.threadId ?? m.threadKey };
    },

    async saveDraft(account, m) {
      await call(account, gmail("/drafts"), { method: "POST", body: { message: { raw: raw(m), ...(m.threadKey ? { threadId: m.threadKey } : {}) } } });
    },

    async archive(account, threadKey, undo) {
      await call(account, gmail(`/threads/${encodeURIComponent(threadKey)}/modify`), { method: "POST", body: undo ? { addLabelIds: ["INBOX"] } : { removeLabelIds: ["INBOX"] } });
    },

    async createEvent(account, calendarId, e, notify) {
      const r = await call<{ id?: string }>(need(account), calEvent(calendarId, undefined, updates(notify)), { method: "POST", body: { summary: e.title, location: e.location || undefined, ...gTimes(e.start, e.end, e.allDay), attendees: e.attendees.map((p) => ({ email: p.address, ...(p.name ? { displayName: p.name } : {}) })) } });
      return { sourceId: r?.id ?? "" };
    },

    async moveEvent(account, calendarId, eventId, start, end, notify) {
      const current = await get<GEvent>(need(account), calEvent(calendarId, eventId));
      await call(need(account), calEvent(calendarId, eventId, updates(notify)), { method: "PATCH", body: gTimes(start, end, !current.start?.dateTime) });
    },

    async cancelEvent(account, calendarId, eventId, notify) {
      await call(need(account), calEvent(calendarId, eventId, updates(notify)), { method: "DELETE" });
    },

    // Google keeps each guest's answer on the event: the user's own entry changes, and the organizer is told.
    async rsvp(account, calendarId, eventId, answer, note) {
      const current = await get<GEvent>(need(account), calEvent(calendarId, eventId));
      const attendees = current.attendees ?? [];
      if (!attendees.some((a) => a.self)) throw new MailProblem("other", "You're not on this event's guest list, so there's nothing to answer.");
      const next = attendees.map((a) => (a.self ? { ...a, responseStatus: answer, ...(note.trim() ? { comment: note.trim() } : {}) } : a));
      await call(need(account), calEvent(calendarId, eventId, updates(true)), { method: "PATCH", body: { attendees: next } });
    },

    async events(account, calendar, from, to) {
      if (!account) return [];
      const out: SourceEvent[] = [];
      let pageToken: string | undefined;
      for (let i = 0; i < MAX_EVENT_PAGES; i++) {
        const q = new URLSearchParams({ timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), singleEvents: "true", maxResults: "250", ...(pageToken ? { pageToken } : {}) });
        const page = await get<{ items?: GEvent[]; nextPageToken?: string }>(account, cal(`/calendars/${encodeURIComponent(calendar.sourceId)}/events?${q}`));
        out.push(...(page.items ?? []).filter((e) => e.status !== "cancelled").map(toSourceEvent));
        pageToken = page.nextPageToken;
        if (!pageToken) break;
      }
      return out;
    },
  };
}
