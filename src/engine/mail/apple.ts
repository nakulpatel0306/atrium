import { decodeWords, parseAddressList, parseIds, parsePerson } from "./addresses";
import { PIM_COPY, runPim } from "./pim";
import { normalizeAddress } from "./addresses";
import { canonicalRecurrence } from "./recurrence";
import { MailProblem, type AttendeeStatus, type MailSource, type Outgoing, type SourceAccount, type SourceEvent } from "./types";

type PimAccount = { id: string; name: string; addresses: string[]; fullName: string };
type PimMessage = {
  id: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  subject: string;
  from: string;
  to: string;
  cc: string;
  date: string;
  read: boolean;
  sent?: boolean;
  snippet: string;
  attachments: { name: string; size: number }[];
};
type PimEvent = Omit<SourceEvent, "sourceId" | "start" | "end" | "attendees" | "recurrenceId"> & {
  id: string;
  start: string;
  end: string;
  recurrenceId: string | null;
  attendees: { name: string; email: string; status: AttendeeStatus | null }[];
};

const LISTING_TIMEOUT_MS = 180_000;

// The helper's answer, checked to have the list it promised: an older or broken helper gets the plain copy, not a
// JavaScript error shown to the user.
async function list<T>(key: string, args: string[], timeoutMs?: number): Promise<T[]> {
  const r = await runPim<Record<string, unknown>>(args, { timeoutMs });
  const v = r?.[key];
  if (!Array.isArray(v)) throw new MailProblem("other", PIM_COPY.other);
  return v as T[];
}

// Every account Mail.app has, one per account, named by its first address.
export async function appleAccounts(): Promise<SourceAccount[]> {
  const accounts = await list<PimAccount>("accounts", ["mail.accounts"]);
  return accounts.filter((a) => a.addresses.length).map((a) => ({ address: a.addresses[0]!, name: a.fullName || a.name, ref: a.id }));
}

const WRITE_TIMEOUT_MS = 120_000;
export const NO_GUESTS_COPY = "Calendar.app doesn't let other apps invite people. Pick a Google calendar, or do this in Calendar.";

// A write command's answer: {"ok": true}, or the shape the caller asked for.
async function write<T = { ok?: unknown }>(cmd: string, input: unknown, check: (r: T) => boolean = (r) => (r as { ok?: unknown })?.ok === true): Promise<T> {
  const r = await runPim<T>([cmd], { input, timeoutMs: WRITE_TIMEOUT_MS });
  if (!check(r)) throw new MailProblem("other", PIM_COPY.other);
  return r;
}

const mailInput = (account: string | null, m: Outgoing) => {
  if (!account) throw new MailProblem("other", "Mail.app doesn't list this account anymore. Sync, then try again.");
  return {
    account,
    from: normalizeAddress(m.from.address),
    to: m.to.map((p) => ({ name: p.name, address: p.address })),
    cc: m.cc.map((p) => ({ name: p.name, address: p.address })),
    subject: m.subject,
    text: m.text,
    replyTo: m.replyToSourceId,
    attachments: m.attachments.map((a) => a.path),
  };
};

// Mail.app and Calendar.app, through the helper. Threads are built by the engine from each message's headers.
export function appleSource(): MailSource {
  return {
    kind: "apple",

    async messages(account, since) {
      if (!account.ref) return { messages: [], versions: {} };
      // Headers only, so it can run longer than a body fetch; the helper caps Inbox and Sent separately.
      const messages = await list<PimMessage>("messages", ["mail.messages", "--account", account.ref, "--since", new Date(since).toISOString()], LISTING_TIMEOUT_MS);
      return {
        messages: messages.map((m) => ({
          sourceId: m.id,
          messageId: parseIds(m.messageId)[0] ?? null,
          inReplyTo: parseIds(m.inReplyTo)[0] ?? null,
          references: parseIds(m.references),
          subject: decodeWords(m.subject),
          from: parsePerson(m.from),
          to: parseAddressList(m.to),
          cc: parseAddressList(m.cc),
          date: Date.parse(m.date) || 0,
          snippet: m.snippet,
          unread: !m.read,
          sent: m.sent === true,
          labels: [],
          attachments: m.attachments.map((a) => ({ ...a, ref: a.name })),
        })),
        versions: {},
      };
    },

    async body(_account, sourceId) {
      const r = await runPim<{ message?: { text?: unknown; html?: unknown; attachments?: unknown } }>(["mail.message", "--id", sourceId]);
      const m = r?.message;
      if (!m || !Array.isArray(m.attachments)) throw new MailProblem("other", PIM_COPY.other);
      const text = typeof m.text === "string" ? m.text : null;
      const html = typeof m.html === "string" ? m.html : null;
      return { text, html, attachments: (m.attachments as { name: string; size: number }[]).map((a) => ({ ...a, ref: a.name })) };
    },

    async attachment(_account, sourceId, att, dir) {
      const r = await runPim<{ path?: unknown }>(["mail.attachment", "--id", sourceId, "--name", att.ref, "--out", dir]);
      if (typeof r?.path !== "string") throw new MailProblem("other", PIM_COPY.other);
      return r.path;
    },

    async calendars() {
      const calendars = await list<{ id: string; title: string; color: string; writable: boolean; source: string; account: string | null }>("calendars", ["cal.calendars"]);
      return calendars.map((c) => ({ sourceId: c.id, title: c.title, color: c.color, writable: c.writable, accountAddress: c.account }));
    },

    // A visible compose window, filled in; the user checks it and presses Send in Mail.
    async compose(account, m) {
      await write("mail.compose", mailInput(account.ref, m));
    },

    async createEvent(_account, calendarId, e) {
      if (e.attendees.length) throw new MailProblem("unsupported", NO_GUESTS_COPY);
      const r = await write<{ event?: { id?: unknown } }>(
        "cal.create",
        { calendar: calendarId, title: e.title, start: new Date(e.start).toISOString(), end: new Date(e.end).toISOString(), allDay: e.allDay, location: e.location },
        (x) => typeof x?.event?.id === "string",
      );
      return { sourceId: r.event!.id as string };
    },

    async events(_account, calendar, from, to) {
      const events = await list<PimEvent>("events", ["cal.events", "--calendar", calendar.sourceId, "--from", new Date(from).toISOString(), "--to", new Date(to).toISOString()]);
      return events.map((e) => ({
        sourceId: e.id,
        icalUid: e.icalUid,
        recurrenceId: canonicalRecurrence(e.recurrenceId),
        title: e.title,
        start: Date.parse(e.start),
        end: Date.parse(e.end),
        allDay: e.allDay,
        location: e.location,
        attendees: e.attendees.map((a) => ({ name: a.name, address: a.email.toLowerCase(), status: a.status })),
        organizer: e.organizer?.toLowerCase() ?? null,
        myStatus: e.myStatus,
        recurrence: e.recurrence,
      }));
    },
  };
}
