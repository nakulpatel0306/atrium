import type { Database } from "bun:sqlite";
import { AlreadyResolved, type Approval, createApproval, getApproval } from "../approvals";
import { bus } from "../events";
import { newId } from "../ids";
import { oneLine } from "../messaging/rules";
import { normalizeAddress } from "./addresses";
import {
  type ActionKind,
  bodyProblem,
  type EventKind,
  isEvent,
  KIND_NOUN,
  MANY_RECIPIENTS,
  markAdded,
  type MailKind,
  namesLine,
  personLabel,
  type Reason,
  type Recipient,
  recipientsProblem,
  replyRecipients,
  subjectFor,
  subjectProblem,
  uniquePeople,
} from "./compose";
import { activeAccounts, getAccount, listAccounts, listCalendars, type MailAccount } from "./store";
import type { Person } from "./types";

// Emails and calendar changes as message actions, the way texts are (messaging/store.ts): each draft has an
// always-ask approval, the card shows exactly what goes out, and only the user's own Send on that card resolves it.
// Recipients of a reply come from the thread's stored headers; Claude can only add to them, and what it adds is
// marked on the card.

export class BadMail extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadMail";
  }
}

export type EventPlan = {
  calendarId: string;
  // The stored event a move or cancel is about; null for a new one.
  eventId: string | null;
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  location: string;
  attendees: Recipient[];
  // Whether the people on it hear about this. A new event with guests always invites them.
  notify: boolean;
};

// unsure: Gmail may have sent it; the user checks his Sent mail before sending again, and no card comes back.
// opened: opened in Mail.app for the user to send from there.
export type MailStatus = "draft" | "sending" | "sent" | "failed" | "unsure" | "rejected" | "saving" | "saved" | "opened";
export type ForwardedAttachment = { name: string; size: number; index: number };

export type MailAction = {
  id: string;
  approvalId: string;
  spaceId: string;
  taskId: string | null;
  kind: ActionKind;
  status: MailStatus;
  draftedBy: "you" | "claude";
  accountId: string | null;
  threadId: string | null;
  sourceMessageId: string | null;
  threadAccountId: string | null;
  inReplyTo: string | null;
  references: string[];
  subject: string;
  body: string;
  quoted: string;
  to: Recipient[];
  cc: Recipient[];
  attachments: ForwardedAttachment[];
  event: EventPlan | null;
  reasons: Reason[];
  // On a draft, why the previous try failed; on a failed action, why this one did.
  error: string | null;
  sentAt: number | null;
  createdAt: number;
  updatedAt: number;
};

type Row = {
  id: string;
  approval_id: string;
  space_id: string;
  task_id: string | null;
  kind: ActionKind;
  status: MailStatus;
  drafted_by: "you" | "claude";
  account_id: string | null;
  thread_id: string | null;
  source_message_id: string | null;
  thread_account_id: string | null;
  in_reply_to: string | null;
  refs: string;
  subject: string;
  body: string;
  quoted: string;
  to_json: string;
  cc_json: string;
  attachments: string;
  event_json: string | null;
  reasons: string;
  error: string | null;
  sent_at: number | null;
  created_at: number;
  updated_at: number;
};

const parse = <T>(s: string | null, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

const toAction = (r: Row): MailAction => ({
  id: r.id,
  approvalId: r.approval_id,
  spaceId: r.space_id,
  taskId: r.task_id,
  kind: r.kind,
  status: r.status,
  draftedBy: r.drafted_by,
  accountId: r.account_id,
  threadId: r.thread_id,
  sourceMessageId: r.source_message_id,
  threadAccountId: r.thread_account_id,
  inReplyTo: r.in_reply_to,
  references: parse<string[]>(r.refs, []),
  subject: r.subject,
  body: r.body,
  quoted: r.quoted,
  to: parse<Recipient[]>(r.to_json, []),
  cc: parse<Recipient[]>(r.cc_json, []),
  attachments: parse<ForwardedAttachment[]>(r.attachments, []),
  event: parse<EventPlan | null>(r.event_json, null),
  reasons: parse<Reason[]>(r.reasons, []),
  error: r.error,
  sentAt: r.sent_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const getMailAction = (db: Database, id: string): MailAction | null => {
  const row = db.query("SELECT * FROM mail_actions WHERE id = ?").get(id) as Row | null;
  return row ? toAction(row) : null;
};

export const mailActionForApproval = (db: Database, approvalId: string): MailAction | null => {
  const row = db.query("SELECT * FROM mail_actions WHERE approval_id = ?").get(approvalId) as Row | null;
  return row ? toAction(row) : null;
};

// Drafts still waiting on the user, oldest first.
export const pendingMailActions = (db: Database): MailAction[] =>
  (
    db
      .query(
        `SELECT m.* FROM mail_actions m JOIN approvals a ON a.id = m.approval_id
         WHERE m.status IN ('draft','saving') AND a.status = 'pending' ORDER BY m.created_at, m.rowid`,
      )
      .all() as Row[]
  ).map(toAction);

// Every address the user sends from, through either source.
export const ownAddresses = (db: Database): Set<string> =>
  new Set((db.query("SELECT DISTINCT address FROM mail_accounts").all() as { address: string }[]).map((r) => r.address));

const YEAR_MS = 365 * 86_400_000;

// Someone the user has written to in the last year: on To or Cc of a message the source filed as sent, or of an
// Atrium send. Being on someone else's email, or on one that only claims to be from the user, doesn't count. Only the
// cached window is searched, so this errs toward showing the note.
function knownPerson(db: Database, address: string, now: number): boolean {
  const a = normalizeAddress(address);
  const sent = db
    .query(
      `SELECT 1 FROM mail_messages m WHERE m.sent = 1 AND m.date >= ? AND (
         EXISTS (SELECT 1 FROM json_each(m.to_json) p WHERE lower(json_extract(p.value, '$.address')) = ?)
         OR EXISTS (SELECT 1 FROM json_each(m.cc_json) p WHERE lower(json_extract(p.value, '$.address')) = ?)) LIMIT 1`,
    )
    .get(now - YEAR_MS, a, a);
  if (sent) return true;
  return !!db
    .query(
      `SELECT 1 FROM mail_actions m WHERE m.status = 'sent' AND m.sent_at >= ? AND (
         EXISTS (SELECT 1 FROM json_each(m.to_json) p WHERE lower(json_extract(p.value, '$.address')) = ?)
         OR EXISTS (SELECT 1 FROM json_each(m.cc_json) p WHERE lower(json_extract(p.value, '$.address')) = ?)
         OR EXISTS (SELECT 1 FROM json_each(json_extract(m.event_json, '$.attendees')) p WHERE lower(json_extract(p.value, '$.address')) = ?)) LIMIT 1`,
    )
    .get(now - YEAR_MS, a, a, a);
}

const calendarSource = (db: Database, id: string) => (db.query("SELECT source FROM cal_calendars WHERE id = ?").get(id) as { source: "google" | "apple" } | null)?.source ?? null;

// The spec's "to a certain extent": what makes a draft need a fresh, explicit Send. Each is a note on the card.
export function explicitReasons(
  db: Database,
  a: Pick<MailAction, "kind" | "accountId" | "threadId" | "sourceMessageId" | "threadAccountId" | "to" | "cc" | "attachments" | "event">,
  now = Date.now(),
): Reason[] {
  const own = ownAddresses(db);
  const event = isEvent(a.kind);
  const people = event ? (a.event?.attendees ?? []) : [...a.to, ...a.cc];
  const out: Reason[] = [];
  // Replying is the everyday case, so on a thread these aren't "first time": the sender of the message answered, and
  // anyone on a message of this thread the source filed as sent. To and Cc of incoming mail don't count: a sender
  // writes those, and could otherwise plant an address that reply all then mails with no note.
  const exempt = new Set(own);
  if (a.threadId) {
    if (a.kind === "reply" || a.kind === "reply_all") {
      const answered = a.sourceMessageId ? (db.query("SELECT from_json FROM mail_messages WHERE id = ?").get(a.sourceMessageId) as { from_json: string } | null) : null;
      const from = parse<Person>(answered?.from_json ?? "{}", { name: "", address: "" }).address;
      if (from) exempt.add(normalizeAddress(from));
    }
    for (const m of db.query("SELECT to_json, cc_json FROM mail_messages WHERE thread_id = ? AND sent = 1").all(a.threadId) as { to_json: string; cc_json: string }[]) {
      for (const p of [...parse<Person[]>(m.to_json, []), ...parse<Person[]>(m.cc_json, [])]) exempt.add(normalizeAddress(p.address));
    }
  }
  for (const p of people) {
    if (exempt.has(normalizeAddress(p.address)) || knownPerson(db, p.address, now)) continue;
    out.push({ kind: "first_time", key: `first_time:${normalizeAddress(p.address)}`, text: `first time ${event ? "inviting" : "emailing"} ${personLabel(p)}` });
  }
  // A forward carries the thread's words to whoever it goes to; anyone who wasn't on that thread is called out, whoever
  // drafted it.
  if (a.kind === "forward" && a.threadId) {
    const row = db.query("SELECT participants FROM mail_threads WHERE id = ?").get(a.threadId) as { participants: string } | null;
    const onThread = new Set([...own, ...parse<Person[]>(row?.participants ?? "[]", []).map((p) => normalizeAddress(p.address))]);
    for (const p of people) if (!onThread.has(normalizeAddress(p.address))) out.push({ kind: "outside_thread", key: `outside_thread:${normalizeAddress(p.address)}`, text: `forwards to ${personLabel(p)}, who wasn't on the thread` });
  }
  if (a.attachments.length) out.push({ kind: "attachments", key: `attachments:${a.attachments.length}`, text: a.attachments.length === 1 ? "1 attachment" : `${a.attachments.length} attachments` });
  if (!event && a.threadAccountId && a.accountId) {
    const from = getAccount(db, a.accountId)?.address;
    const thread = getAccount(db, a.threadAccountId)?.address;
    if (from && thread && from !== thread) out.push({ kind: "other_account", key: `other_account:${from}`, text: `from ${from}, not ${thread}` });
  }
  if (people.length > MANY_RECIPIENTS) out.push({ kind: "many", key: `many:${people.length}`, text: `${people.length} people` });
  return out;
}

const dayTime = (ms: number) => new Date(ms).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function actionTitle(a: Pick<MailAction, "kind" | "to" | "subject" | "event">): string {
  if (a.kind === "event_create") return a.event?.attendees.length ? `Create "${a.event.title}" and invite ${namesLine(a.event.attendees)}?` : `Create "${a.event?.title}"?`;
  if (a.kind === "event_move") return `Move "${a.event?.title}"?`;
  if (a.kind === "event_cancel") return `Cancel "${a.event?.title}"?`;
  return `Send ${a.kind === "new" ? "an email" : `a ${KIND_NOUN[a.kind]}`} to ${namesLine(a.to)}?`;
}

const peopleText = (people: Recipient[]) => people.map((p) => `${p.name ? `${p.name} <${p.address}>` : p.address}${p.added ? " (added by Claude)" : ""}`).join(", ");

// What the approval says, for anywhere that shows it as text (the terminal app, the activity's detail).
export function actionDetail(db: Database, a: MailAction): string {
  const lines: string[] = [];
  if (a.error) lines.push(`Last try failed: ${oneLine(a.error)}`);
  for (const r of a.reasons) lines.push(`Note: ${r.text}`);
  if (a.event) {
    const cal = listCalendars(db).find((c) => c.id === a.event!.calendarId);
    lines.push(`Calendar: ${cal?.title ?? "not picked"}`, `When: ${a.event.allDay ? new Date(a.event.start).toDateString() : `${dayTime(a.event.start)} to ${dayTime(a.event.end)}`}`);
    if (a.event.location) lines.push(`Where: ${a.event.location}`);
    if (a.event.attendees.length) lines.push(`Guests: ${peopleText(a.event.attendees)}`, a.event.notify ? "Guests are told." : "Guests aren't told.");
    lines.push("", "On approve, Atrium makes exactly this change through the calendar's own source.");
    return lines.join("\n");
  }
  const from = a.accountId ? getAccount(db, a.accountId) : null;
  lines.push(`From: ${from?.address ?? "not picked"}`, `To: ${peopleText(a.to)}`);
  if (a.cc.length) lines.push(`Cc: ${peopleText(a.cc)}`);
  lines.push(`Subject: ${a.subject || "(no subject)"}`);
  if (a.attachments.length) lines.push(`Attachments: ${a.attachments.map((x) => x.name).join(", ")}`);
  lines.push("", ...a.body.split("\n").map((l) => `> ${l}`));
  // Everything that goes out is shown: the quoted reply or the forwarded message under the user's own words.
  if (a.quoted) lines.push("", a.kind === "forward" ? "The forwarded message goes below it:" : "The message you're answering is quoted below it:", ...a.quoted.split("\n").map((l) => `> ${l}`));
  lines.push("", "On Send, Atrium sends exactly this through the account's own mail source.");
  return lines.join("\n");
}

type ThreadMessage = { id: string; account_id: string; source_id: string; message_id: string | null; refs: string; from_json: string; to_json: string; cc_json: string; date: number; subject: string; attachments: string; body: string | null; snippet: string };

// The newest message of a thread (or the one named), with its body if cached, for answering it.
function messageToAnswer(db: Database, threadId: string, messageId?: string | null): ThreadMessage | null {
  const sql = `SELECT m.*, b.text AS body FROM mail_messages m LEFT JOIN mail_bodies b ON b.message_id = m.id WHERE m.thread_id = ?${messageId ? " AND m.id = ?" : ""} ORDER BY m.date DESC, m.rowid DESC LIMIT 1`;
  return db.query(sql).get(...(messageId ? [threadId, messageId] : [threadId])) as ThreadMessage | null;
}

const QUOTE_MAX = 20_000;

function quotedFor(kind: MailKind, m: ThreadMessage): string {
  const from = parse<Person>(m.from_json, { name: "", address: "" });
  const text = (m.body ?? m.snippet).slice(0, QUOTE_MAX).trimEnd();
  const when = new Date(m.date).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  const who = from.name ? `${from.name} <${from.address}>` : from.address;
  if (kind === "forward") {
    const to = parse<Person[]>(m.to_json, []).map((p) => (p.name ? `${p.name} <${p.address}>` : p.address)).join(", ");
    return ["---------- Forwarded message ---------", `From: ${who}`, `Date: ${when}`, `Subject: ${m.subject}`, `To: ${to}`, "", text].join("\n");
  }
  return [`On ${when}, ${who} wrote:`, ...text.split("\n").map((l) => `> ${l}`)].join("\n");
}

// A From the user can pick: an account that's synced and shown. The thread's own account comes first.
export const NO_FROM_COPY = "Pick one of your connected accounts to send from.";

// The row an address sends through now: its preferred one, whichever source that is. A crossover address has two
// rows, and only this one is ever used, so it never goes out twice.
export function sendingRow(db: Database, accountId: string | null): MailAccount | null {
  const picked = accountId ? getAccount(db, accountId) : null;
  return picked ? (listAccounts(db).find((a) => a.address === picked.address && a.preferred) ?? null) : null;
}

function pickAccount(db: Database, wanted: string | null | undefined, fallback: string | null): string {
  const active = activeAccounts(db);
  const ids = new Set(active.map((a) => a.id));
  if (wanted && ids.has(wanted)) return wanted;
  if (wanted) {
    // An address names its preferred row, whichever source that is.
    const byAddress = active.find((a) => a.address === normalizeAddress(wanted));
    if (byAddress) return byAddress.id;
    throw new BadMail(NO_FROM_COPY);
  }
  if (fallback && ids.has(fallback)) return fallback;
  const first = active[0];
  if (!first) throw new BadMail("Connect a mail account in Settings › Accounts first.");
  return first.id;
}

export type MailDraftInput = {
  spaceId: string;
  taskId?: string | null;
  kind: MailKind;
  draftedBy: "you" | "claude";
  // reply, reply all and forward: the thread, and optionally which message on it.
  threadId?: string | null;
  messageId?: string | null;
  accountId?: string | null;
  // For a reply these are only additions to the thread's own people; for a forward or new email, the whole list.
  to?: Person[];
  cc?: Person[];
  subject?: string;
  body: string;
  lastError?: string | null;
};

type Fields = Omit<MailAction, "id" | "approvalId" | "status" | "sentAt" | "createdAt" | "updatedAt" | "reasons">;

function insert(db: Database, f: Fields, now = Date.now()): { action: MailAction; approval: Approval } {
  const reasons = explicitReasons(db, f, now);
  const made = db.transaction(() => {
    const draft = { ...f, reasons } as MailAction;
    const approval = createApproval(db, {
      spaceId: f.spaceId,
      taskId: f.taskId ?? undefined,
      kind: "question",
      title: actionTitle(f),
      detail: actionDetail(db, draft),
      alwaysAsk: "send_message",
    });
    const id = newId("mla");
    db.query(
      `INSERT INTO mail_actions (id, approval_id, space_id, task_id, kind, status, drafted_by, account_id, thread_id, source_message_id, thread_account_id,
         in_reply_to, refs, subject, body, quoted, to_json, cc_json, attachments, event_json, reasons, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, approval.id, f.spaceId, f.taskId ?? null, f.kind, f.draftedBy, f.accountId, f.threadId, f.sourceMessageId, f.threadAccountId,
      f.inReplyTo, JSON.stringify(f.references), f.subject, f.body, f.quoted, JSON.stringify(f.to), JSON.stringify(f.cc),
      JSON.stringify(f.attachments), f.event ? JSON.stringify(f.event) : null, JSON.stringify(reasons), f.error, now, now,
    );
    return { action: getMailAction(db, id)!, approval };
  })();
  bus.emit({ type: "changed" });
  return made;
}

const REFS_KEPT = 20;

export function draftMail(db: Database, input: MailDraftInput): { action: MailAction; approval: Approval } {
  // A card the user opens starts empty; its words are checked when he presses Send.
  const problem = input.draftedBy === "you" && !input.body.trim() ? null : bodyProblem(input.body, input.kind);
  if (problem) throw new BadMail(problem);
  const own = ownAddresses(db);
  const claude = input.draftedBy === "claude";
  const asAdded = (people: Person[] = []): Recipient[] => uniquePeople(people, own).map((p) => ({ ...p, added: claude }));
  let f: Fields;
  if (input.kind === "new") {
    const subject = (input.subject ?? "").trim();
    const sp = subjectProblem(subject);
    if (sp) throw new BadMail(sp);
    f = base(input, { accountId: pickAccount(db, input.accountId, null), subject, to: asAdded(input.to), cc: asAdded(input.cc) });
  } else {
    const thread = input.threadId ? (db.query("SELECT id, account_id, thread_key FROM mail_threads WHERE id = ?").get(input.threadId) as { id: string; account_id: string; thread_key: string } | null) : null;
    if (!thread) throw new BadMail("That thread isn't in the Inbox anymore. Sync, then try again.");
    const m = messageToAnswer(db, thread.id, input.messageId);
    if (!m) throw new BadMail("That message isn't on the thread anymore. Sync, then try again.");
    const accountId = pickAccount(db, input.accountId, thread.account_id);
    const original = { from: parse<Person>(m.from_json, { name: "", address: "" }), to: parse<Person[]>(m.to_json, []), cc: parse<Person[]>(m.cc_json, []) };
    let to: Recipient[];
    let cc: Recipient[];
    if (input.kind === "forward") {
      to = asAdded(input.to);
      cc = asAdded(input.cc);
    } else {
      const fromThread = replyRecipients(own, original, input.kind);
      to = [...fromThread.to.map((p) => ({ ...p, added: false })), ...asAdded(input.to)];
      cc = [...fromThread.cc.map((p) => ({ ...p, added: false })), ...asAdded(input.cc)];
      to = uniquePeople(to);
      cc = uniquePeople(cc, new Set(to.map((p) => p.address)));
    }
    const reply = input.kind !== "forward";
    f = base(input, {
      accountId,
      threadId: thread.id,
      sourceMessageId: m.id,
      threadAccountId: thread.account_id,
      inReplyTo: reply ? m.message_id : null,
      references: reply ? [...parse<string[]>(m.refs, []), ...(m.message_id ? [m.message_id] : [])].slice(-REFS_KEPT) : [],
      subject: subjectFor(input.kind, m.subject),
      quoted: quotedFor(input.kind, m),
      to,
      cc,
      attachments: input.kind === "forward" ? parse<{ name: string; size: number }[]>(m.attachments, []).map((x, index) => ({ name: x.name, size: x.size, index })) : [],
    });
  }
  // Claude's draft must already be one that could go out, so the review says why when it can't; the user's own
  // card may start empty and is checked at Send.
  if (claude) {
    const problem = recipientsProblem(f.to, f.cc);
    if (problem) throw new BadMail(problem);
  }
  return insert(db, f);
}

function base(input: { spaceId: string; taskId?: string | null; kind: ActionKind; draftedBy: "you" | "claude"; body?: string; lastError?: string | null }, over: Partial<Fields>): Fields {
  return {
    spaceId: input.spaceId,
    taskId: input.taskId ?? null,
    kind: input.kind,
    draftedBy: input.draftedBy,
    accountId: null,
    threadId: null,
    sourceMessageId: null,
    threadAccountId: null,
    inReplyTo: null,
    references: [],
    subject: "",
    body: (input.body ?? "").trim(),
    quoted: "",
    to: [],
    cc: [],
    attachments: [],
    event: null,
    error: input.lastError ? oneLine(input.lastError) : null,
    ...over,
  };
}

// ---- Calendar changes

export const MAX_EVENT_DAYS = 14;
const TITLE_MAX = 200;

// A calendar Atrium may write to: shown, enabled and writable.
export const writableCalendars = (db: Database) => {
  const writable = new Set((db.query("SELECT id FROM cal_calendars WHERE writable = 1").all() as { id: string }[]).map((r) => r.id));
  return listCalendars(db).filter((c) => c.enabled && !c.hidden && writable.has(c.id));
};

export function eventProblem(db: Database, kind: EventKind, e: EventPlan): string | null {
  if (!writableCalendars(db).some((c) => c.id === e.calendarId)) return "Pick a calendar Atrium can add to.";
  if (kind === "event_cancel") return null;
  const t = e.title.trim();
  if (!t || t.length > TITLE_MAX || subjectProblem(t)) return "Give the event a one-line title under 200 characters.";
  if (subjectProblem(e.location)) return "Keep the location to one line, with no hidden characters.";
  if (!Number.isFinite(e.start) || !Number.isFinite(e.end) || e.end <= e.start) return "The event has to end after it starts.";
  if (e.end - e.start > MAX_EVENT_DAYS * 86_400_000) return `Atrium makes events of up to ${MAX_EVENT_DAYS} days.`;
  if (e.attendees.length) return recipientsProblem(e.attendees, []);
  return null;
}

type StoredEvent = { id: string; calendar_id: string; source_id: string; title: string; start_at: number; end_at: number; all_day: number; location: string; attendees: string; organizer: string | null; recurrence: string | null; recurrence_id: string };

export const REPEATING_COPY = "Change repeating events in Google Calendar.";
export const APPLE_EVENT_COPY = "Change Calendar.app events in Calendar.";

// An event the user may move or cancel: a single Google event (not one day of a series, not Calendar.app), on a
// calendar Atrium can write to, and organised by the user (or by no one).
export function ownedEvent(db: Database, eventId: string): StoredEvent {
  const e = db.query("SELECT * FROM cal_events WHERE id = ?").get(eventId) as StoredEvent | null;
  if (!e) throw new BadMail("That event isn't in the calendar anymore. Sync, then try again.");
  // One occurrence of a series can't be changed safely yet, so no path (agent, route or card) may draft it.
  if (e.recurrence || e.recurrence_id) throw new BadMail(REPEATING_COPY);
  // Calendar.app events open in Calendar instead: EventKit's changes can tell guests without asking.
  if (calendarSource(db, e.calendar_id) === "apple") throw new BadMail(APPLE_EVENT_COPY);
  if (e.organizer && !ownAddresses(db).has(normalizeAddress(e.organizer))) throw new BadMail("Only the organizer can move or cancel this event. Reply to the invite instead.");
  if (!writableCalendars(db).some((c) => c.id === e.calendar_id)) throw new BadMail("Atrium can't change events on that calendar.");
  return e;
}

export type EventDraftInput = {
  spaceId: string;
  taskId?: string | null;
  kind: EventKind;
  draftedBy: "you" | "claude";
  // event_create
  calendarId?: string | null;
  title?: string;
  start?: number;
  end?: number;
  allDay?: boolean;
  location?: string;
  attendees?: Person[];
  // event_move and event_cancel
  eventId?: string | null;
  notify?: boolean;
  lastError?: string | null;
};

export function draftEvent(db: Database, input: EventDraftInput): { action: MailAction; approval: Approval } {
  const own = ownAddresses(db);
  let plan: EventPlan;
  if (input.kind === "event_create") {
    const calendarId = input.calendarId && writableCalendars(db).some((c) => c.id === input.calendarId) ? input.calendarId : (writableCalendars(db)[0]?.id ?? "");
    const attendees = uniquePeople(input.attendees ?? [], own).map((p) => ({ ...p, added: input.draftedBy === "claude" }));
    plan = { calendarId, eventId: null, title: (input.title ?? "").trim(), start: input.start ?? NaN, end: input.end ?? NaN, allDay: !!input.allDay, location: (input.location ?? "").trim(), attendees, notify: true };
  } else {
    const e = ownedEvent(db, input.eventId ?? "");
    const attendees = parse<Person[]>(e.attendees, []).filter((p) => !own.has(normalizeAddress(p.address))).map((p) => ({ name: p.name, address: p.address, added: false }));
    plan = {
      calendarId: e.calendar_id,
      eventId: e.id,
      title: e.title,
      start: input.start ?? e.start_at,
      end: input.end ?? (input.start !== undefined ? input.start + (e.end_at - e.start_at) : e.end_at),
      allDay: e.all_day === 1,
      location: e.location,
      attendees,
      notify: attendees.length > 0 && input.notify !== false,
    };
  }
  const problem = eventProblem(db, input.kind, plan);
  if (problem) throw new BadMail(problem);
  return insert(db, base(input, { event: plan, body: "" }));
}

// ---- Edits and status

// Only while the user hasn't decided: what he decides on is exactly what goes out.
function draftOrThrow(db: Database, id: string): MailAction {
  const a = getMailAction(db, id);
  if (!a) throw new BadMail("That draft isn't there anymore.");
  if (a.status !== "draft" || getApproval(db, a.approvalId)?.status !== "pending") throw new AlreadyResolved();
  return a;
}

function write(db: Database, a: MailAction, now = Date.now()): MailAction {
  const reasons = explicitReasons(db, a, now);
  const next = { ...a, reasons };
  db.query(
    "UPDATE mail_actions SET account_id = ?, subject = ?, body = ?, to_json = ?, cc_json = ?, event_json = ?, reasons = ?, updated_at = ? WHERE id = ? AND status = 'draft'",
  ).run(a.accountId, a.subject, a.body, JSON.stringify(a.to), JSON.stringify(a.cc), a.event ? JSON.stringify(a.event) : null, JSON.stringify(reasons), now, a.id);
  db.query("UPDATE approvals SET title = ?, detail = ? WHERE id = ? AND status = 'pending'").run(actionTitle(next), actionDetail(db, next), a.approvalId);
  return getMailAction(db, a.id)!;
}

export type MailEdit = { accountId: string; to: Person[]; cc: Person[]; subject: string; body: string };

// The user's edits to an email card. A reply's subject stays the thread's, so it keeps threading.
export function updateMailDraft(db: Database, id: string, patch: MailEdit): MailAction {
  const next = db.transaction(() => {
    const cur = draftOrThrow(db, id);
    if (isEvent(cur.kind)) throw new BadMail("This is a calendar change, not an email.");
    // An empty From is refused, never swapped for another account.
    if (!patch.accountId) throw new BadMail(NO_FROM_COPY);
    const accountId = pickAccount(db, patch.accountId, null);
    const to = markAdded(patch.to, [...cur.to, ...cur.cc]);
    const cc = markAdded(patch.cc, [...cur.to, ...cur.cc]).filter((p) => !to.some((t) => t.address === p.address));
    const problem = recipientsProblem(to, cc) ?? bodyProblem(patch.body, cur.kind) ?? (cur.kind === "new" ? subjectProblem(patch.subject) : null);
    if (problem) throw new BadMail(problem);
    return write(db, { ...cur, accountId, to, cc, subject: cur.kind === "new" ? patch.subject.trim() : cur.subject, body: patch.body.trim() });
  })();
  bus.emit({ type: "changed" });
  return next;
}

export type EventEdit = { calendarId: string; title: string; start: number; end: number; allDay: boolean; location: string; attendees: Person[]; notify: boolean };

// The user's edits to an event card. A move keeps its calendar and guests; a cancel only chooses whether they're told.
export function updateEventDraft(db: Database, id: string, patch: EventEdit): MailAction {
  const next = db.transaction(() => {
    const cur = draftOrThrow(db, id);
    if (!cur.event || !isEvent(cur.kind)) throw new BadMail("This is an email, not a calendar change.");
    const e = cur.event;
    const plan: EventPlan =
      cur.kind === "event_create"
        ? { ...e, calendarId: patch.calendarId, title: patch.title.trim(), start: patch.start, end: patch.end, allDay: patch.allDay, location: patch.location.trim(), attendees: markAdded(patch.attendees, e.attendees), notify: true }
        : cur.kind === "event_move"
          ? { ...e, start: patch.start, end: patch.end, notify: e.attendees.length > 0 && patch.notify }
          : { ...e, notify: e.attendees.length > 0 && patch.notify };
    const problem = eventProblem(db, cur.kind, plan);
    if (problem) throw new BadMail(problem);
    return write(db, { ...cur, event: plan });
  })();
  bus.emit({ type: "changed" });
  return next;
}

const MOVES: Record<MailStatus, MailStatus[]> = {
  // Straight to failed only when the executor refuses to send at all.
  draft: ["sending", "rejected", "failed", "saving", "opened"],
  sending: ["sent", "failed", "unsure"],
  // Saving to Gmail Drafts: done, or back to a draft when Gmail couldn't.
  saving: ["saved", "draft"],
  sent: [],
  failed: [],
  unsure: [],
  opened: [],
  rejected: [],
  saved: [],
};

// Guarded on the status it read, so two callers racing to send the same draft can't both move it.
export function setMailStatus(db: Database, id: string, to: MailStatus, patch: { error?: string | null; sentAt?: number } = {}): MailAction {
  const cur = getMailAction(db, id);
  if (!cur) throw new Error(`No mail draft with id ${id}`);
  if (!MOVES[cur.status].includes(to)) throw new Error(`A mail draft can't go from ${cur.status} to ${to}.`);
  const res = db
    .query("UPDATE mail_actions SET status = ?, error = ?, sent_at = ?, updated_at = ? WHERE id = ? AND status = ?")
    .run(to, patch.error !== undefined ? patch.error : to === "sent" ? null : cur.error, patch.sentAt ?? cur.sentAt, Date.now(), id, cur.status);
  if (res.changes === 0) throw new Error(`The mail draft ${id} changed while updating it.`);
  bus.emit({ type: "changed" });
  return getMailAction(db, id)!;
}

// A failed send comes back as a fresh draft with the reason, so the next try is again the user's own Send.
export function redraftMail(db: Database, a: MailAction, error: string): { action: MailAction; approval: Approval } {
  const { id: _i, approvalId: _a, status: _s, sentAt: _t, createdAt: _c, updatedAt: _u, reasons: _r, ...fields } = a;
  return insert(db, { ...fields, error: oneLine(error) });
}
