// Mail and calendar, cached from the sources the user connected. Every row here came from someone else's mail or
// calendar, so all of it is untrusted text: shown as text, and handed to agents only inside the untrusted block.
//
// One row per (address, source): the same address reachable through Google and through Mail.app has two rows, and
// exactly one of them is preferred. Only the preferred row is synced and shown; the other is kept so switching back
// is one click.
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
`;
