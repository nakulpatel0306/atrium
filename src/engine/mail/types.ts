// The one shape every mail and calendar source is read through. Google (Gmail + Google Calendar, per connected
// account) and Apple (Mail.app + Calendar.app, through the atrium-pim helper) each implement it; sync.ts never
// knows which it's talking to. Phase B adds the write half (send, saveDraft, createEvent, rsvp) to this same type,
// so a send always goes out through the account's preferred source.

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
};

// A source that couldn't do what was asked, in words for the user. kind lets the caller mark the account
// (signed_out) or point at the right System Settings pane.
export type MailProblemKind = "signed_out" | "automation_denied" | "calendar_denied" | "not_installed" | "timeout" | "offline" | "other";
export class MailProblem extends Error {
  constructor(
    readonly kind: MailProblemKind,
    message: string,
  ) {
    super(message);
    this.name = "MailProblem";
  }
}
