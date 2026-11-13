// Mail and calendar, cached from the sources the user connected. Every row here came from someone else's mail or
// calendar, so all of it is untrusted text: shown as text, and handed to agents only inside the untrusted block.
//
// One row per (address, source): the same address reachable through Google and through Mail.app has two rows, and
// exactly one of them is preferred. Only the preferred row is synced and shown; the other is kept so switching back
// is one click.
// Drafted emails and calendar changes waiting on the user's own Send (or Approve), and what became of them. Each has
// an always-ask approval; nothing here is ever sent by a rule, an agent or the engine on its own.
export const MAIL_ACTIONS_DDL = (name: string) => `
CREATE TABLE ${name} (
  id TEXT PRIMARY KEY,
  approval_id TEXT NOT NULL UNIQUE REFERENCES approvals(id),
  space_id TEXT NOT NULL,
  task_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('reply','reply_all','forward','new','event_create','event_move','event_cancel')),
  -- unsure: Gmail may have sent it (no answer, or one Atrium couldn't read); the user checks before sending again.
  -- opened: a Mail.app account's message, opened in Mail for the user to send himself.
  status TEXT NOT NULL CHECK (status IN ('draft','sending','sent','failed','unsure','rejected','saving','saved','opened')),
  drafted_by TEXT NOT NULL CHECK (drafted_by IN ('you','claude')),
  -- The From account row; NULL for calendar changes.
  account_id TEXT,
  -- The thread and message replied to or forwarded, and the thread's account when drafted.
  thread_id TEXT,
  source_message_id TEXT,
  thread_account_id TEXT,
  -- Threading the engine sets: Gmail's threadId (for a reply from the thread's own Google account) and the headers.
  gmail_thread_id TEXT,
  in_reply_to TEXT,
  refs TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  -- The quoted original (reply) or forwarded message, added below the body on send. Shown, not edited.
  quoted TEXT NOT NULL DEFAULT '',
  -- JSON [{name, address, added}]; added marks a recipient Claude put there beyond the thread's own people.
  to_json TEXT NOT NULL DEFAULT '[]',
  cc_json TEXT NOT NULL DEFAULT '[]',
  -- JSON [{name, size, index}]: the forwarded message's attachments, by their index on it.
  attachments TEXT NOT NULL DEFAULT '[]',
  -- JSON, calendar changes only: {calendarId, eventId, title, start, end, allDay, location, attendees, notify}.
  event_json TEXT,
  -- JSON [{kind, text}]: why this needs the user's explicit Send (a new person, attachments, another account, many people).
  reasons TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  sent_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`;

export const MAIL_SCHEMA = `
CREATE TABLE IF NOT EXISTS mail_accounts (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL CHECK (source IN ('google','apple')),
  -- Mail.app's own account id for an apple row; NULL for google, whose tokens are keyed by this row's id.
  source_ref TEXT,
  preferred INTEGER NOT NULL DEFAULT 0,
  color TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','signed_out','error')),
  last_error TEXT,
  synced_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (address, source)
);
CREATE TABLE IF NOT EXISTS mail_threads (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES mail_accounts(id),
  -- Gmail's threadId, or the root Message-ID the engine threaded an Apple message under.
  thread_key TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  -- JSON [{name, address}], everyone on the thread but the account itself.
  participants TEXT NOT NULL DEFAULT '[]',
  last_at INTEGER NOT NULL,
  unread INTEGER NOT NULL DEFAULT 0,
  labels TEXT NOT NULL DEFAULT '[]',
  snippet TEXT NOT NULL DEFAULT '',
  -- The last message is to the account directly, from a person, and unanswered.
  needs_reply INTEGER NOT NULL DEFAULT 0,
  -- Gmail's historyId when last read, so an unchanged thread isn't fetched again.
  source_version TEXT,
  UNIQUE (account_id, thread_key)
);
CREATE INDEX IF NOT EXISTS mail_threads_last ON mail_threads(last_at);
CREATE TABLE IF NOT EXISTS mail_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES mail_threads(id),
  account_id TEXT NOT NULL REFERENCES mail_accounts(id),
  -- The RFC 5322 Message-ID when there is one, else "src:<source id>": the identity that keeps a message single.
  msg_key TEXT NOT NULL,
  message_id TEXT,
  -- The source's own id (Gmail message id, Mail.app message id), for fetching the body later.
  source_id TEXT NOT NULL,
  in_reply_to TEXT,
  refs TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  from_json TEXT NOT NULL DEFAULT '{}',
  to_json TEXT NOT NULL DEFAULT '[]',
  cc_json TEXT NOT NULL DEFAULT '[]',
  date INTEGER NOT NULL,
  snippet TEXT NOT NULL DEFAULT '',
  unread INTEGER NOT NULL DEFAULT 0,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  -- JSON [{name, size, ref}]; ref is what the source needs to fetch it.
  attachments TEXT NOT NULL DEFAULT '[]',
  body_cached_at INTEGER,
  UNIQUE (account_id, msg_key)
);
CREATE INDEX IF NOT EXISTS mail_messages_thread ON mail_messages(thread_id, date);
CREATE INDEX IF NOT EXISTS mail_messages_mid ON mail_messages(message_id);
-- Bodies fetched on demand, plain text only, capped per message and in total (body.ts).
CREATE TABLE IF NOT EXISTS mail_bodies (
  message_id TEXT PRIMARY KEY REFERENCES mail_messages(id),
  text TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0,
  cached_at INTEGER NOT NULL
);
-- Attachments saved for opening, by path, so removing an account or ageing out its mail removes exactly these files.
CREATE TABLE IF NOT EXISTS mail_saved_files (
  path TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  saved_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mail_saved_files_account ON mail_saved_files(account_id);
CREATE INDEX IF NOT EXISTS mail_saved_files_message ON mail_saved_files(message_id);
CREATE TABLE IF NOT EXISTS cal_calendars (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('google','apple')),
  source_id TEXT NOT NULL,
  -- The Google account row a google calendar was read through; NULL for apple.
  account_id TEXT REFERENCES mail_accounts(id),
  -- For an apple calendar, the address of the account it syncs from when Calendar.app names one, so a Google
  -- calendar that also comes in directly is read once.
  account_address TEXT,
  title TEXT NOT NULL,
  color TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  writable INTEGER NOT NULL DEFAULT 0,
  UNIQUE (source, source_id)
);
CREATE TABLE IF NOT EXISTS cal_events (
  id TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL REFERENCES cal_calendars(id),
  source_id TEXT NOT NULL,
  ical_uid TEXT NOT NULL,
  -- The occurrence's original start for one instance of a recurring event; '' for a single event.
  recurrence_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  location TEXT NOT NULL DEFAULT '',
  -- JSON [{name, address, status}].
  attendees TEXT NOT NULL DEFAULT '[]',
  organizer TEXT,
  my_status TEXT CHECK (my_status IS NULL OR my_status IN ('accepted','declined','tentative','needs_action')),
  recurrence TEXT,
  UNIQUE (calendar_id, ical_uid, recurrence_id)
);
CREATE INDEX IF NOT EXISTS cal_events_start ON cal_events(start_at);
CREATE INDEX IF NOT EXISTS cal_events_uid ON cal_events(ical_uid, recurrence_id);
${MAIL_ACTIONS_DDL("IF NOT EXISTS mail_actions")};
CREATE INDEX IF NOT EXISTS mail_actions_thread ON mail_actions(thread_id);
-- Gmail threads the user archived from Atrium, hidden from the Inbox until new mail arrives on them.
CREATE TABLE IF NOT EXISTS mail_archived (
  thread_id TEXT PRIMARY KEY,
  archived_at INTEGER NOT NULL
);
`;
