import type { Database } from "bun:sqlite";
import { bus } from "../events";
import { getSetting, setSetting } from "../settings";
import { normalizeAddress, normalizeSubject } from "./addresses";
import { ACCOUNT_COLORS } from "./colors";
import { canOpen, removeSaved, safeFileName } from "./files";
import type { AttendeeStatus, Person, SourceAttachment, SourceCalendar, SourceEvent, SourceKind, SourceMessage } from "./types";

export type MailAccount = {
  id: string;
  address: string;
  name: string;
  source: SourceKind;
  ref: string | null;
  preferred: boolean;
  color: string;
  enabled: boolean;
  status: "ok" | "signed_out" | "error";
  lastError: string | null;
  syncedAt: number | null;
  createdAt: number;
};

type AccountRow = {
  id: string;
  address: string;
  display_name: string;
  source: SourceKind;
  source_ref: string | null;
  preferred: number;
  color: string;
  enabled: number;
  status: MailAccount["status"];
  last_error: string | null;
  synced_at: number | null;
  created_at: number;
};

const toAccount = (r: AccountRow): MailAccount => ({
  id: r.id,
  address: r.address,
  name: r.display_name,
  source: r.source,
  ref: r.source_ref,
  preferred: r.preferred === 1,
  color: r.color,
  enabled: r.enabled === 1,
  status: r.status,
  lastError: r.last_error,
  syncedAt: r.synced_at,
  createdAt: r.created_at,
});

// Ids are derived from what makes a row unique, so the same message or event arriving again lands on the same row.
export const hashId = (prefix: string, ...parts: string[]): string =>
  `${prefix}_${new Bun.CryptoHasher("sha256").update(parts.join("\0")).digest("hex").slice(0, 20)}`;


const json = <T>(s: string, fallback: T): T => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

export function listAccounts(db: Database): MailAccount[] {
  return (db.query("SELECT * FROM mail_accounts ORDER BY created_at, rowid").all() as AccountRow[]).map(toAccount);
}

export function getAccount(db: Database, id: string): MailAccount | null {
  const row = db.query("SELECT * FROM mail_accounts WHERE id = ?").get(id) as AccountRow | null;
  return row ? toAccount(row) : null;
}

// The rows that are synced and shown: one per address, the preferred one, and only while enabled.
export const activeAccounts = (db: Database): MailAccount[] => listAccounts(db).filter((a) => a.preferred && a.enabled);

const choiceKey = (address: string) => `mail.preferred.${address}`;

// Adds or refreshes the row for this address and source. A new address's first row is preferred. Google takes over
// from Mail.app for an address that has both, since it's authoritative for threads and labels, unless the user has
// picked Mail.app for that address in Settings.
export function upsertAccount(db: Database, input: { address: string; name: string; source: SourceKind; ref: string | null }): MailAccount {
  const address = normalizeAddress(input.address);
  const existing = db.query("SELECT * FROM mail_accounts WHERE address = ? AND source = ?").get(address, input.source) as AccountRow | null;
  if (existing) {
    db.query("UPDATE mail_accounts SET display_name = ?, source_ref = ? WHERE id = ?").run(input.name || existing.display_name, input.ref, existing.id);
    return getAccount(db, existing.id)!;
  }
  const id = hashId("mac", address, input.source);
  const sibling = db.query("SELECT color, preferred, source FROM mail_accounts WHERE address = ?").get(address) as { color: string; preferred: number; source: SourceKind } | null;
  const count = (db.query("SELECT COUNT(DISTINCT address) AS n FROM mail_accounts").get() as { n: number }).n;
  const color = sibling?.color ?? ACCOUNT_COLORS[count % ACCOUNT_COLORS.length]!;
  const chosen = getSetting(db, choiceKey(address));
  const preferred = !sibling || (chosen ? chosen === input.source : input.source === "google");
  db.transaction(() => {
    if (preferred && sibling) clearOthers(db, address, id);
    db.query(
      "INSERT INTO mail_accounts (id, address, display_name, source, source_ref, preferred, color, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)",
    ).run(id, address, input.name, input.source, input.ref, preferred ? 1 : 0, color, Date.now());
  })();
  bus.emit({ type: "changed" });
  return getAccount(db, id)!;
}

// The other rows for an address stop being preferred, and their cached mail goes: it's ignored from now on, and
// the preferred source fills the Inbox again on its next sync.
function clearOthers(db: Database, address: string, keep: string) {
  for (const r of db.query("SELECT id FROM mail_accounts WHERE address = ? AND id != ?").all(address, keep) as { id: string }[]) {
    db.query("UPDATE mail_accounts SET preferred = 0, synced_at = NULL WHERE id = ?").run(r.id);
    dropMail(db, r.id);
  }
}

export function setPreferred(db: Database, id: string): MailAccount {
  const a = getAccount(db, id);
  if (!a) throw new Error("No such account.");
  db.transaction(() => {
    clearOthers(db, a.address, id);
    db.query("UPDATE mail_accounts SET preferred = 1 WHERE id = ?").run(id);
  })();
  setSetting(db, choiceKey(a.address), a.source);
  bus.emit({ type: "changed" });
  return getAccount(db, id)!;
}

export function updateAccount(db: Database, id: string, patch: { color?: string; enabled?: boolean }): MailAccount {
  const a = getAccount(db, id);
  if (!a) throw new Error("No such account.");
  // Colour belongs to the address, so both of its rows keep the same dot.
  if (patch.color !== undefined) db.query("UPDATE mail_accounts SET color = ? WHERE address = ?").run(patch.color, a.address);
  if (patch.enabled !== undefined) db.query("UPDATE mail_accounts SET enabled = ? WHERE id = ?").run(patch.enabled ? 1 : 0, id);
  bus.emit({ type: "changed" });
  return getAccount(db, id)!;
}

export function markAccount(db: Database, id: string, status: MailAccount["status"], error: string | null, syncedAt?: number): void {
  if (syncedAt !== undefined) db.query("UPDATE mail_accounts SET status = ?, last_error = ?, synced_at = ? WHERE id = ?").run(status, error, syncedAt, id);
  else db.query("UPDATE mail_accounts SET status = ?, last_error = ? WHERE id = ?").run(status, error, id);
}

// Everything cached for one account row: its threads, messages, bodies, and the Google calendars read through it.
function dropMail(db: Database, accountId: string) {
  removeSaved(db, { accountId });
  db.query("DELETE FROM mail_bodies WHERE message_id IN (SELECT id FROM mail_messages WHERE account_id = ?)").run(accountId);
  db.query("DELETE FROM mail_messages WHERE account_id = ?").run(accountId);
  db.query("DELETE FROM mail_threads WHERE account_id = ?").run(accountId);
  db.query("DELETE FROM cal_events WHERE calendar_id IN (SELECT id FROM cal_calendars WHERE account_id = ?)").run(accountId);
  db.query("DELETE FROM cal_calendars WHERE account_id = ?").run(accountId);
}

// Disconnect: the row and everything cached for it. The address's other row, if any, becomes the preferred one.
export function removeAccount(db: Database, id: string): void {
  const a = getAccount(db, id);
  if (!a) return;
  db.transaction(() => {
    dropMail(db, id);
    db.query("DELETE FROM mail_accounts WHERE id = ?").run(id);
    if (a.preferred) db.query("UPDATE mail_accounts SET preferred = 1 WHERE id = (SELECT id FROM mail_accounts WHERE address = ? ORDER BY created_at LIMIT 1)").run(a.address);
  })();
  bus.emit({ type: "changed" });
}

// Removes every Apple row (Mail.app turned off in Settings); the addresses' Google rows take over.
export function removeSourceAccounts(db: Database, source: SourceKind): void {
  for (const a of listAccounts(db).filter((x) => x.source === source)) removeAccount(db, a.id);
}

// ---- Threads and messages

const AUTOMATED = /(^|[._+-])(no-?reply|do-?not-?reply|notifications?|mailer-daemon|bounces?|newsletters?|updates|alerts|info|support)([._+-]|@)/i;
const BULK_LABELS = ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_UPDATES", "CATEGORY_FORUMS", "SPAM", "TRASH"];

// Phase A's needs-a-reply heuristic: the newest message is to this address directly, from a person rather than a
// list or robot, and nobody on the account has answered since.
export function needsReply(own: string, last: { from: Person; to: Person[]; labels: string[] }): boolean {
  if (!last.from.address || last.from.address === own) return false;
  if (AUTOMATED.test(last.from.address)) return false;
  if (last.labels.some((l) => BULK_LABELS.includes(l))) return false;
  if (last.to.length > 10) return false;
  return last.to.some((p) => p.address === own);
}

// Where a message without a Gmail threadId belongs, from its headers:
// 1. a message it references or replies to is already stored: that message's thread;
// 2. its own Message-ID is a thread's root, or a stored reply references it: that thread;
// 3. it references something not stored yet: a thread rooted at the first reference, which the parent joins later;
// 4. a reply ("Re:") with no threading headers: an earlier thread with the same subject and the same people;
// 5. otherwise a thread of its own.
export function threadKeyFor(db: Database, accountId: string, own: string, m: SourceMessage): string {
  const refs = [...m.references, ...(m.inReplyTo ? [m.inReplyTo] : [])];
  for (const id of [...refs].reverse()) {
    const hit = db.query("SELECT t.thread_key FROM mail_messages m JOIN mail_threads t ON t.id = m.thread_id WHERE m.account_id = ? AND m.message_id = ?").get(accountId, id) as { thread_key: string } | null;
    if (hit) return hit.thread_key;
  }
  if (m.messageId) {
    const root = db.query("SELECT thread_key FROM mail_threads WHERE account_id = ? AND thread_key = ?").get(accountId, m.messageId) as { thread_key: string } | null;
    if (root) return root.thread_key;
    const child = db
      .query("SELECT t.thread_key FROM mail_messages m JOIN mail_threads t ON t.id = m.thread_id WHERE m.account_id = ? AND (m.in_reply_to = ? OR m.refs LIKE ?) LIMIT 1")
      .get(accountId, m.messageId, `%${JSON.stringify(m.messageId)}%`) as { thread_key: string } | null;
    if (child) return child.thread_key;
  }
  if (refs.length) return m.references[0] ?? m.inReplyTo!;
  const subject = normalizeSubject(m.subject);
  if (subject && subject !== m.subject.trim().toLowerCase()) {
    const people = peopleKey(own, [m.from, ...m.to, ...m.cc]);
    const rows = db
      .query("SELECT thread_key, subject, participants FROM mail_threads WHERE account_id = ? AND last_at <= ? ORDER BY last_at DESC LIMIT 200")
      .all(accountId, m.date) as { thread_key: string; subject: string; participants: string }[];
    const same = rows.find((r) => normalizeSubject(r.subject) === subject && peopleKey(own, json<Person[]>(r.participants, [])) === people);
    if (same) return same.thread_key;
  }
  return m.messageId ?? `src:${m.sourceId}`;
}

const peopleKey = (own: string, people: Person[]) =>
  [...new Set(people.map((p) => p.address).filter((a) => a && a !== own))].sort().join(",");

// Stores what a source returned for one account. Messages keep one row per Message-ID, so a message read twice
// (a second sync, or a thread fetched again) updates rather than duplicates. versions are Gmail historyIds.
export function ingestMessages(db: Database, account: { id: string; address: string }, messages: SourceMessage[], versions: Record<string, string> = {}): number {
  const touched = new Set<string>();
  let added = 0;
  const sorted = [...messages].sort((a, b) => a.date - b.date);
  db.transaction(() => {
    for (const m of sorted) {
      const key = m.messageId ?? `src:${m.sourceId}`;
      const existing = db.query("SELECT id, thread_id FROM mail_messages WHERE account_id = ? AND msg_key = ?").get(account.id, key) as { id: string; thread_id: string } | null;
      if (existing) {
        db.query("UPDATE mail_messages SET unread = ?, source_id = ? WHERE id = ?").run(m.unread ? 1 : 0, m.sourceId, existing.id);
        touched.add(existing.thread_id);
        labelThread(db, existing.thread_id, m.labels);
        continue;
      }
      const threadKey = m.threadKey ?? threadKeyFor(db, account.id, account.address, m);
      const threadId = hashId("mth", account.id, threadKey);
      db.query("INSERT OR IGNORE INTO mail_threads (id, account_id, thread_key, subject, last_at) VALUES (?, ?, ?, ?, ?)").run(threadId, account.id, threadKey, m.subject, m.date);
      labelThread(db, threadId, m.labels);
      db.query(
        `INSERT INTO mail_messages (id, thread_id, account_id, msg_key, message_id, source_id, in_reply_to, refs, subject, from_json, to_json, cc_json, date, snippet, unread, has_attachments, attachments)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        hashId("msg", account.id, key),
        threadId,
        account.id,
        key,
        m.messageId,
        m.sourceId,
        m.inReplyTo,
        JSON.stringify(m.references),
        m.subject,
        JSON.stringify(m.from),
        JSON.stringify(m.to),
        JSON.stringify(m.cc),
        m.date,
        m.snippet,
        m.unread ? 1 : 0,
        m.attachments.length ? 1 : 0,
        JSON.stringify(m.attachments),
      );
      touched.add(threadId);
      added++;
    }
    for (const [threadKey, version] of Object.entries(versions)) {
      db.query("UPDATE mail_threads SET source_version = ? WHERE account_id = ? AND thread_key = ?").run(version, account.id, threadKey);
    }
    for (const id of touched) refreshThread(db, id, account.address);
  })();
  if (touched.size) bus.emit({ type: "changed" });
  return added;
}

// A thread's labels are the latest set any of its messages reported.
function labelThread(db: Database, threadId: string, labels: string[]) {
  if (labels.length) db.query("UPDATE mail_threads SET labels = ? WHERE id = ?").run(JSON.stringify([...new Set(labels)]), threadId);
}

type MessageRow = {
  id: string;
  thread_id: string;
  message_id: string | null;
  source_id: string;
  subject: string;
  from_json: string;
  to_json: string;
  cc_json: string;
  date: number;
  snippet: string;
  unread: number;
  attachments: string;
  body_cached_at: number | null;
};

// The thread row's summary columns, worked out again from its messages.
function refreshThread(db: Database, threadId: string, own: string) {
  const msgs = db.query("SELECT * FROM mail_messages WHERE thread_id = ? ORDER BY date, rowid").all(threadId) as MessageRow[];
  if (!msgs.length) return;
  const first = msgs[0]!;
  const last = msgs.at(-1)!;
  const people = new Map<string, Person>();
  for (const m of msgs) {
    for (const p of [json<Person>(m.from_json, { name: "", address: "" }), ...json<Person[]>(m.to_json, []), ...json<Person[]>(m.cc_json, [])]) {
      if (!p.address || p.address === own) continue;
      if (!people.has(p.address) || (!people.get(p.address)!.name && p.name)) people.set(p.address, p);
    }
  }
  const labels = json<string[]>((db.query("SELECT labels FROM mail_threads WHERE id = ?").get(threadId) as { labels: string }).labels, []);
  const reply = needsReply(own, { from: json<Person>(last.from_json, { name: "", address: "" }), to: json<Person[]>(last.to_json, []), labels });
  db.query("UPDATE mail_threads SET subject = ?, participants = ?, last_at = ?, unread = ?, snippet = ?, needs_reply = ? WHERE id = ?").run(
    first.subject || last.subject,
    JSON.stringify([...people.values()]),
    last.date,
    msgs.filter((m) => m.unread === 1).length,
    last.snippet,
    reply ? 1 : 0,
    threadId,
  );
}

export const threadVersion = (db: Database, accountId: string, threadKey: string): string | null =>
  (db.query("SELECT source_version FROM mail_threads WHERE account_id = ? AND thread_key = ?").get(accountId, threadKey) as { source_version: string | null } | null)?.source_version ?? null;

// Mail older than the sync window leaves the cache with its bodies.
export function pruneMail(db: Database, before: number): void {
  const old = (db.query("SELECT id FROM mail_messages WHERE date < ?").all(before) as { id: string }[]).map((r) => r.id);
  if (old.length) removeSaved(db, { messageIds: old });
  db.transaction(() => {
    db.query("DELETE FROM mail_bodies WHERE message_id IN (SELECT id FROM mail_messages WHERE date < ?)").run(before);
    db.query("DELETE FROM mail_messages WHERE date < ?").run(before);
    db.query("DELETE FROM mail_threads WHERE id NOT IN (SELECT DISTINCT thread_id FROM mail_messages)").run();
  })();
}

export type ThreadView = {
  id: string;
  account: { id: string; address: string; color: string };
  subject: string;
  participants: Person[];
  lastAt: number;
  unread: number;
  labels: string[];
  snippet: string;
  needsReply: boolean;
  count: number;
};

type ThreadRow = {
  id: string;
  account_id: string;
  address: string;
  color: string;
  subject: string;
  participants: string;
  last_at: number;
  unread: number;
  labels: string;
  snippet: string;
  needs_reply: number;
  count: number;
};

const toThread = (r: ThreadRow): ThreadView => ({
  id: r.id,
  account: { id: r.account_id, address: r.address, color: r.color },
  subject: r.subject,
  participants: json<Person[]>(r.participants, []),
  lastAt: r.last_at,
  unread: r.unread,
  labels: json<string[]>(r.labels, []),
  snippet: r.snippet,
  needsReply: r.needs_reply === 1,
  count: r.count,
});

const THREAD_SELECT = `SELECT t.*, a.address, a.color, (SELECT COUNT(*) FROM mail_messages m WHERE m.thread_id = t.id) AS count
  FROM mail_threads t JOIN mail_accounts a ON a.id = t.account_id
  WHERE a.preferred = 1 AND a.enabled = 1`;

// The unified Inbox, newest first, from active accounts only, so an address read two ways shows once.
export function listThreads(db: Database, opts: { accountId?: string; filter?: "unread" | "needs_reply"; limit?: number; search?: string } = {}): ThreadView[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (opts.accountId) {
    where.push("a.id = ?");
    args.push(opts.accountId);
  }
  if (opts.filter === "unread") where.push("t.unread > 0");
  if (opts.filter === "needs_reply") where.push("t.needs_reply = 1");
  if (opts.search) {
    where.push("(t.subject LIKE ? OR t.participants LIKE ? OR t.snippet LIKE ?)");
    const like = `%${opts.search.replace(/[%_]/g, "")}%`;
    args.push(like, like, like);
  }
  const sql = `${THREAD_SELECT}${where.map((w) => ` AND ${w}`).join("")} ORDER BY t.last_at DESC LIMIT ?`;
  return (db.query(sql).all(...args, opts.limit ?? 200) as ThreadRow[]).map(toThread);
}

export function getThreadView(db: Database, id: string): ThreadView | null {
  const row = db.query(`${THREAD_SELECT} AND t.id = ?`).get(id) as ThreadRow | null;
  return row ? toThread(row) : null;
}

export type MessageView = {
  id: string;
  sourceId: string;
  messageId: string | null;
  subject: string;
  from: Person;
  to: Person[];
  cc: Person[];
  date: number;
  snippet: string;
  unread: boolean;
  // openable: whether Atrium will open it with a named app; otherwise it's offered in Finder only.
  attachments: { name: string; size: number; openable: boolean }[];
  body: string | null;
  truncated: boolean;
};

export function threadMessages(db: Database, threadId: string): MessageView[] {
  const rows = db
    .query("SELECT m.*, b.text AS body, b.truncated FROM mail_messages m LEFT JOIN mail_bodies b ON b.message_id = m.id WHERE m.thread_id = ? ORDER BY m.date, m.rowid")
    .all(threadId) as (MessageRow & { body: string | null; truncated: number | null })[];
  return rows.map((r) => ({
    id: r.id,
    sourceId: r.source_id,
    messageId: r.message_id,
    subject: r.subject,
    from: json<Person>(r.from_json, { name: "", address: "" }),
    to: json<Person[]>(r.to_json, []),
    cc: json<Person[]>(r.cc_json, []),
    date: r.date,
    snippet: r.snippet,
    unread: r.unread === 1,
    attachments: json<SourceAttachment[]>(r.attachments, []).map((a) => ({ name: safeFileName(a.name), size: a.size, openable: canOpen(a.name) })),
    body: r.body,
    truncated: r.truncated === 1,
  }));
}

export function messageSource(db: Database, messageId: string): { accountId: string; sourceId: string; attachments: SourceAttachment[] } | null {
  const r = db.query("SELECT account_id, source_id, attachments FROM mail_messages WHERE id = ?").get(messageId) as { account_id: string; source_id: string; attachments: string } | null;
  return r ? { accountId: r.account_id, sourceId: r.source_id, attachments: json<SourceAttachment[]>(r.attachments, []) } : null;
}

// ---- Calendars and events

export type CalendarRow = {
  id: string;
  source: SourceKind;
  source_id: string;
  account_id: string | null;
  account_address: string | null;
  title: string;
  color: string;
  enabled: number;
  writable: number;
};

export function upsertCalendar(db: Database, source: SourceKind, cal: SourceCalendar, accountId: string | null): string {
  const id = hashId("cal", source, cal.sourceId);
  db.query(
    `INSERT INTO cal_calendars (id, source, source_id, account_id, account_address, title, color, writable) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source, source_id) DO UPDATE SET account_id = excluded.account_id, account_address = excluded.account_address, title = excluded.title, color = excluded.color, writable = excluded.writable`,
  ).run(id, source, cal.sourceId, accountId, cal.accountAddress ? normalizeAddress(cal.accountAddress) : null, cal.title, cal.color, cal.writable ? 1 : 0);
  return id;
}

// An Apple calendar that syncs from an address Google reads directly (and is preferred for) is the same calendar
// twice, so it's skipped.
export function calendarShadowed(db: Database, accountAddress: string | null): boolean {
  if (!accountAddress) return false;
  return !!db.query("SELECT 1 FROM mail_accounts WHERE address = ? AND source = 'google' AND preferred = 1 AND enabled = 1").get(normalizeAddress(accountAddress));
}

// The window's events for one calendar, replacing what was stored for that window.
export function replaceEvents(db: Database, calendarId: string, events: SourceEvent[], from: number, to: number): void {
  db.transaction(() => {
    const keep = new Set<string>();
    for (const e of events) {
      const id = hashId("evt", calendarId, e.icalUid, e.recurrenceId ?? "");
      keep.add(id);
      db.query(
        `INSERT INTO cal_events (id, calendar_id, source_id, ical_uid, recurrence_id, title, start_at, end_at, all_day, location, attendees, organizer, my_status, recurrence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(calendar_id, ical_uid, recurrence_id) DO UPDATE SET source_id = excluded.source_id, title = excluded.title, start_at = excluded.start_at,
           end_at = excluded.end_at, all_day = excluded.all_day, location = excluded.location, attendees = excluded.attendees, organizer = excluded.organizer,
           my_status = excluded.my_status, recurrence = excluded.recurrence`,
      ).run(id, calendarId, e.sourceId, e.icalUid, e.recurrenceId ?? "", e.title, e.start, e.end, e.allDay ? 1 : 0, e.location, JSON.stringify(e.attendees), e.organizer, e.myStatus, e.recurrence);
    }
    const stale = db.query("SELECT id FROM cal_events WHERE calendar_id = ? AND start_at < ? AND end_at > ?").all(calendarId, to, from) as { id: string }[];
    for (const s of stale) if (!keep.has(s.id)) db.query("DELETE FROM cal_events WHERE id = ?").run(s.id);
  })();
}

// Calendars a source no longer lists, with their events.
export function dropCalendars(db: Database, source: SourceKind, keepIds: string[], accountId: string | null): void {
  const rows = db.query(`SELECT id FROM cal_calendars WHERE source = ? AND ${accountId ? "account_id = ?" : "account_id IS NULL"}`).all(...(accountId ? [source, accountId] : [source])) as { id: string }[];
  for (const r of rows) {
    if (keepIds.includes(r.id)) continue;
    db.query("DELETE FROM cal_events WHERE calendar_id = ?").run(r.id);
    db.query("DELETE FROM cal_calendars WHERE id = ?").run(r.id);
  }
}

export type EventView = {
  id: string;
  calendar: { id: string; title: string; color: string; source: SourceKind };
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  location: string;
  attendees: (Person & { status: AttendeeStatus | null })[];
  organizer: string | null;
  myStatus: AttendeeStatus | null;
  recurring: boolean;
};

export type CalendarView = { id: string; title: string; color: string; source: SourceKind; enabled: boolean; hidden: string | null };

// Every calendar, with why one isn't shown: its account isn't the preferred source, or Google reads it directly.
export function listCalendars(db: Database): CalendarView[] {
  const rows = db.query("SELECT c.*, a.preferred, a.enabled AS account_enabled FROM cal_calendars c LEFT JOIN mail_accounts a ON a.id = c.account_id ORDER BY c.source DESC, c.title").all() as (CalendarRow & {
    preferred: number | null;
    account_enabled: number | null;
  })[];
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    color: r.color,
    source: r.source,
    enabled: r.enabled === 1,
    hidden:
      r.source === "google" && (r.preferred !== 1 || r.account_enabled !== 1)
        ? "Its account reads through Mail.app now."
        : r.source === "apple" && calendarShadowed(db, r.account_address)
          ? "Google reads this calendar directly."
          : null,
  }));
}

export function setCalendarEnabled(db: Database, id: string, enabled: boolean): void {
  db.query("UPDATE cal_calendars SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
  bus.emit({ type: "changed" });
}

// Events overlapping [from, to), all calendars merged. The same event (iCalUID and occurrence) from two calendars
// or two sources shows once, from Google when Google has it.
export function listEvents(db: Database, from: number, to: number): EventView[] {
  const shown = new Set(listCalendars(db).filter((c) => c.enabled && !c.hidden).map((c) => c.id));
  const rows = db
    .query(
      `SELECT e.*, c.title AS cal_title, c.color AS cal_color, c.source AS cal_source FROM cal_events e JOIN cal_calendars c ON c.id = e.calendar_id
       WHERE e.start_at < ? AND e.end_at > ? ORDER BY e.start_at, CASE c.source WHEN 'google' THEN 0 ELSE 1 END, e.rowid`,
    )
    .all(to, from) as {
    id: string;
    calendar_id: string;
    ical_uid: string;
    recurrence_id: string;
    title: string;
    start_at: number;
    end_at: number;
    all_day: number;
    location: string;
    attendees: string;
    organizer: string | null;
    my_status: AttendeeStatus | null;
    recurrence: string | null;
    cal_title: string;
    cal_color: string;
    cal_source: SourceKind;
  }[];
  const seen = new Set<string>();
  const out: EventView[] = [];
  for (const r of rows) {
    if (!shown.has(r.calendar_id)) continue;
    const key = `${r.ical_uid}\0${r.recurrence_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: r.id,
      calendar: { id: r.calendar_id, title: r.cal_title, color: r.cal_color, source: r.cal_source },
      title: r.title,
      start: r.start_at,
      end: r.end_at,
      allDay: r.all_day === 1,
      location: r.location,
      attendees: json(r.attendees, []),
      organizer: r.organizer,
      myStatus: r.my_status,
      recurring: !!r.recurrence || r.recurrence_id !== "",
    });
  }
  return out;
}
