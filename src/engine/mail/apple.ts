import { parseAddressList, parseIds, parsePerson } from "./addresses";
import { runPim } from "./pim";
import { canonicalRecurrence } from "./recurrence";
import type { AttendeeStatus, MailSource, SourceAccount, SourceEvent } from "./types";

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

const MESSAGE_LIMIT = 500;

// Every account Mail.app has, one per account, named by its first address.
export async function appleAccounts(): Promise<SourceAccount[]> {
  const r = await runPim<{ accounts: PimAccount[] }>(["mail.accounts"]);
  return r.accounts.filter((a) => a.addresses.length).map((a) => ({ address: a.addresses[0]!, name: a.fullName || a.name, ref: a.id }));
}

// Mail.app and Calendar.app, through the helper. Threads are built by the engine from each message's headers.
export function appleSource(): MailSource {
  return {
    kind: "apple",

    async messages(account, since) {
      if (!account.ref) return { messages: [], versions: {} };
      const r = await runPim<{ messages: PimMessage[] }>(["mail.messages", "--account", account.ref, "--since", new Date(since).toISOString(), "--limit", String(MESSAGE_LIMIT)]);
      return {
        messages: r.messages.map((m) => ({
          sourceId: m.id,
          messageId: parseIds(m.messageId)[0] ?? null,
          inReplyTo: parseIds(m.inReplyTo)[0] ?? null,
          references: parseIds(m.references),
          subject: m.subject,
          from: parsePerson(m.from),
          to: parseAddressList(m.to),
          cc: parseAddressList(m.cc),
          date: Date.parse(m.date) || 0,
          snippet: m.snippet,
          unread: !m.read,
          labels: [],
          attachments: m.attachments.map((a) => ({ ...a, ref: a.name })),
        })),
        versions: {},
      };
    },

    async body(_account, sourceId) {
      const r = await runPim<{ message: { text: string | null; html: string | null; attachments: { name: string; size: number }[] } }>(["mail.message", "--id", sourceId]);
      return { text: r.message.text, html: r.message.html, attachments: r.message.attachments.map((a) => ({ ...a, ref: a.name })) };
    },

    async attachment(_account, sourceId, att, dir) {
      const r = await runPim<{ path: string }>(["mail.attachment", "--id", sourceId, "--name", att.ref, "--out", dir]);
      return r.path;
    },

    async calendars() {
      const r = await runPim<{ calendars: { id: string; title: string; color: string; writable: boolean; source: string; account: string | null }[] }>(["cal.calendars"]);
      return r.calendars.map((c) => ({ sourceId: c.id, title: c.title, color: c.color, writable: c.writable, accountAddress: c.account }));
    },

    async events(_account, calendar, from, to) {
      const r = await runPim<{ events: PimEvent[] }>(["cal.events", "--calendar", calendar.sourceId, "--from", new Date(from).toISOString(), "--to", new Date(to).toISOString()]);
      return r.events.map((e) => ({
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
