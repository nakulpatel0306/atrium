// The one shape every mail and calendar source is read through. Google (Gmail + Google Calendar, per connected
// account) and Apple (Mail.app + Calendar.app, through the atrium-pim helper) each implement it; sync.ts never
// knows which it's talking to. The write half (send, saveDraft, the calendar changes, rsvp) is on this same type, and
// send.ts reaches it only through the account's preferred source, so an address read two ways sends once.

export type Person = { name: string; address: string };
export type SourceKind = "google" | "apple";

// An account a source can reach right now. ref is the source's own handle for it (Mail.app's account id).
export type SourceAccount = { address: string; name: string; ref: string | null };

export type SourceAttachment = { name: string; size: number; ref: string };

export type SourceMessage = {
  // The source's own id: Gmail message id or Mail.app message id.
  sourceId: string;
  // Gmail's threadId. Absent for Apple, which the engine threads from the headers below.
  threadKey?: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  subject: string;
  from: Person;
  to: Person[];
  cc: Person[];
  date: number;
  snippet: string;
  unread: boolean;
  labels: string[];
  attachments: SourceAttachment[];
};

// A body as the source gives it; the engine keeps only plain text (body.ts).
export type SourceBody = { text: string | null; html: string | null; attachments: SourceAttachment[] };

export type SourceCalendar = { sourceId: string; title: string; color: string; writable: boolean; accountAddress: string | null };

export type AttendeeStatus = "accepted" | "declined" | "tentative" | "needs_action";
export type SourceEvent = {
  sourceId: string;
  icalUid: string;
  recurrenceId: string | null;
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  location: string;
  attendees: (Person & { status: AttendeeStatus | null })[];
  organizer: string | null;
  myStatus: AttendeeStatus | null;
  recurrence: string | null;
};

// What sync.ts hands a source for one account: the stored row's address and the source's handle for it.
export type AccountRef = { id: string; address: string; ref: string | null };

// One email as the engine built it after the user's Send: the exact people, words and threading headers.
export type Outgoing = {
  from: Person;
  to: Person[];
  cc: Person[];
  subject: string;
  // The body with any quoted or forwarded text already below it.
  text: string;
  // Made by the engine; a source that can't set it (Mail.app) lets the mail app make its own.
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  // Gmail's threadId, set only for a reply from the thread's own Google account.
  threadKey: string | null;
  // The source's own id for the message answered, for a source that threads by replying to it (Mail.app).
  replyToSourceId: string | null;
  attachments: { name: string; path: string }[];
};
export type Sent = { sourceId: string | null; threadKey: string | null };

export type OutgoingEvent = { title: string; start: number; end: number; allDay: boolean; location: string; attendees: Person[] };
export type Rsvp = "accepted" | "tentative" | "declined";

export type MailSource = {
  kind: SourceKind;
  // Messages received or sent since `since` (ms). `known` returns the version stored for a Gmail thread, so a
  // source can skip threads that haven't changed.
  messages(account: AccountRef, since: number, known: (threadKey: string) => string | null): Promise<{ messages: SourceMessage[]; versions: Record<string, string> }>;
  body(account: AccountRef, sourceId: string): Promise<SourceBody>;
  // Saves one attachment into `dir` and returns its path.
  attachment(account: AccountRef, sourceId: string, att: SourceAttachment, dir: string): Promise<string>;
  calendars(account: AccountRef | null): Promise<SourceCalendar[]>;
  events(account: AccountRef | null, calendar: SourceCalendar, from: number, to: number): Promise<SourceEvent[]>;

  // The write half. Each is called once per user action and never retried on its own: a call that may have reached
  // the source throws MailProblem "unsure" rather than risk sending twice.
  send(account: AccountRef, mail: Outgoing): Promise<Sent>;
  saveDraft(account: AccountRef, mail: Outgoing): Promise<void>;
  // notify: whether guests hear about it (Google's sendUpdates). Returns the new event's source id.
  createEvent(account: AccountRef | null, calendarId: string, event: OutgoingEvent, notify: boolean): Promise<{ sourceId: string }>;
  moveEvent(account: AccountRef | null, calendarId: string, eventId: string, start: number, end: number, notify: boolean): Promise<void>;
  cancelEvent(account: AccountRef | null, calendarId: string, eventId: string, notify: boolean): Promise<void>;
  rsvp(account: AccountRef | null, calendarId: string, eventId: string, answer: Rsvp, note: string): Promise<void>;
};

// A source that couldn't do what was asked, in words for the user. kind lets the caller mark the account
// (signed_out) or point at the right System Settings pane.
// unsure: the request may have reached the source, so whether it went out isn't known. unsupported: the source has no
// way to do it (Calendar.app can't invite or answer invitations for another app).
export type MailProblemKind = "signed_out" | "automation_denied" | "calendar_denied" | "not_installed" | "timeout" | "offline" | "unsure" | "unsupported" | "other";
export class MailProblem extends Error {
  constructor(
    readonly kind: MailProblemKind,
    message: string,
  ) {
    super(message);
    this.name = "MailProblem";
  }
}
