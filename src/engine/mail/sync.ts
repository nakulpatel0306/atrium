import type { Database } from "bun:sqlite";
import { bus } from "../events";
import { getSetting } from "../settings";
import { bodyText, cacheBody } from "./body";
import { attachmentDir } from "./files";
import {
  activeAccounts,
  calendarShadowed,
  dropCalendars,
  getAccount,
  ingestMessages,
  listAccounts,
  markAccount,
  messageSource,
  pruneMail,
  removeSourceAccounts,
  replaceEvents,
  threadVersion,
  upsertAccount,
  upsertCalendar,
  type MailAccount,
} from "./store";
import { MailProblem, type AccountRef, type MailSource, type SourceAccount } from "./types";

const DAY_MS = 86_400_000;
// Principle 5: while a dashboard, the Mac app or the terminal app is connected, and never otherwise.
export const SYNC_INTERVAL_MS = 10 * 60_000;
// Opening Inbox or Calendar syncs, but not again within a minute of the last one.
const OPEN_FRESH_MS = 60_000;
const BODIES_PER_THREAD = 25;

export const SETTING_KEYS = { mailDays: "mail.window.days", calBack: "cal.window.back", calAhead: "cal.window.ahead" } as const;
export const DEFAULTS = { mailDays: 30, calBack: 30, calAhead: 90 } as const;
export const LIMITS = { mailDays: [1, 365], calBack: [0, 365], calAhead: [1, 730] } as const;
export type MailSettings = { mailDays: number; calBack: number; calAhead: number };
export const APPLE_KEYS = { mail: "mail.apple.mail", calendar: "mail.apple.calendar" } as const;
const PROBLEM_KEYS = { mail: "mail.apple.mailProblem", calendar: "mail.apple.calendarProblem" } as const;
const SYNCED_KEY = "mail.syncedAt";

export function mailSettings(db: Database): MailSettings {
  const read = (k: keyof MailSettings) => {
    const n = Number(getSetting(db, SETTING_KEYS[k]));
    const [lo, hi] = LIMITS[k];
    return Number.isInteger(n) && n >= lo && n <= hi ? n : DEFAULTS[k];
  };
  return { mailDays: read("mailDays"), calBack: read("calBack"), calAhead: read("calAhead") };
}

export const appleOn = (db: Database, what: "mail" | "calendar"): boolean => getSetting(db, APPLE_KEYS[what]) === "on";

// Sync bookkeeping is written straight to settings: one `changed` at the end of a sync is enough for every listener.
const write = (db: Database, key: string, value: string | null) => {
  if (value === null) db.query("DELETE FROM settings WHERE key = ?").run(key);
  else db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
};

export const appleProblem = (db: Database, what: "mail" | "calendar"): string | null => getSetting(db, PROBLEM_KEYS[what]);
export const lastSyncedAt = (db: Database): number | null => Number(getSetting(db, SYNCED_KEY)) || null;

const ref = (a: MailAccount): AccountRef => ({ id: a.id, address: a.address, ref: a.ref });
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export type MailSync = ReturnType<typeof createMailSync>;

export function createMailSync(deps: {
  db: Database;
  google: MailSource;
  apple: MailSource;
  appleAccounts(): Promise<SourceAccount[]>;
  now?: () => number;
  intervalMs?: number;
}) {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const intervalMs = deps.intervalMs ?? SYNC_INTERVAL_MS;
  const sourceOf = (a: MailAccount) => (a.source === "google" ? deps.google : deps.apple);
  let timer: ReturnType<typeof setInterval> | null = null;
  let running: Promise<void> | null = null;

  const configured = () => listAccounts(db).length > 0 || appleOn(db, "mail") || appleOn(db, "calendar");

  async function syncAppleAccounts() {
    try {
      const found = await deps.appleAccounts();
      for (const a of found) upsertAccount(db, { address: a.address, name: a.name, source: "apple", ref: a.ref });
      write(db, PROBLEM_KEYS.mail, null);
    } catch (e) {
      write(db, PROBLEM_KEYS.mail, message(e));
    }
  }

  async function syncMail(at: number, s: MailSettings) {
    const since = at - s.mailDays * DAY_MS;
    for (const a of activeAccounts(db)) {
      if (a.source === "apple" && !appleOn(db, "mail")) continue;
      try {
        const r = await sourceOf(a).messages(ref(a), since, (key) => threadVersion(db, a.id, key));
        ingestMessages(db, a, r.messages, r.versions);
        markAccount(db, a.id, "ok", null, at);
      } catch (e) {
        markAccount(db, a.id, e instanceof MailProblem && e.kind === "signed_out" ? "signed_out" : "error", message(e));
      }
    }
    pruneMail(db, since);
  }

  async function syncCalendars(at: number, s: MailSettings) {
    const from = at - s.calBack * DAY_MS;
    const to = at + s.calAhead * DAY_MS;
    for (const a of activeAccounts(db).filter((x) => x.source === "google")) {
      try {
        const cals = await deps.google.calendars(ref(a));
        const ids = cals.map((c) => upsertCalendar(db, "google", c, a.id));
        dropCalendars(db, "google", ids, a.id);
        for (const [i, c] of cals.entries()) {
          if (!enabled(ids[i]!)) continue;
          replaceEvents(db, ids[i]!, await deps.google.events(ref(a), c, from, to), from, to);
        }
      } catch (e) {
        markAccount(db, a.id, e instanceof MailProblem && e.kind === "signed_out" ? "signed_out" : "error", message(e));
      }
    }
    if (!appleOn(db, "calendar")) return;
    try {
      const cals = await deps.apple.calendars(null);
      const ids = cals.map((c) => upsertCalendar(db, "apple", c, null));
      dropCalendars(db, "apple", ids, null);
      for (const [i, c] of cals.entries()) {
        // The same Google calendar synced into Calendar.app is read once, directly from Google.
        if (!enabled(ids[i]!) || calendarShadowed(db, c.accountAddress)) continue;
        replaceEvents(db, ids[i]!, await deps.apple.events(null, c, from, to), from, to);
      }
      write(db, PROBLEM_KEYS.calendar, null);
    } catch (e) {
      write(db, PROBLEM_KEYS.calendar, message(e));
    }
  }

  const enabled = (calendarId: string) => (db.query("SELECT enabled FROM cal_calendars WHERE id = ?").get(calendarId) as { enabled: number } | null)?.enabled === 1;

  // One sync at a time; a request while one runs joins it.
  function syncNow(): Promise<void> {
    if (running) return running;
    if (!configured()) return Promise.resolve();
    running = (async () => {
      const at = now();
      const s = mailSettings(db);
      if (appleOn(db, "mail")) await syncAppleAccounts();
      await syncMail(at, s);
      await syncCalendars(at, s);
      write(db, SYNCED_KEY, String(at));
    })()
      .catch((e) => console.error(`Mail sync: ${message(e)}`))
      .finally(() => {
        running = null;
        bus.emit({ type: "changed" });
      });
    return running;
  }

  const stale = (maxAge: number) => {
    const last = lastSyncedAt(db);
    return last === null || now() - last >= maxAge;
  };

  async function withSource<T>(messageId: string, fn: (source: MailSource, account: AccountRef, msg: NonNullable<ReturnType<typeof messageSource>>) => Promise<T>): Promise<T> {
    const msg = messageSource(db, messageId);
    if (!msg) throw new MailProblem("other", "That message isn't in the Inbox anymore. Sync, then open the thread again.");
    const account = getAccount(db, msg.accountId);
    if (!account) throw new MailProblem("other", "That message's account isn't connected anymore.");
    return fn(sourceOf(account), ref(account), msg);
  }

  return {
    syncNow,
    syncing: () => running !== null,

    // Clients connecting or leaving. The timer exists only while at least one is connected.
    setClients(n: number) {
      if (n > 0 && !timer) {
        timer = setInterval(() => void syncNow(), intervalMs);
        if (stale(intervalMs)) void syncNow();
      } else if (n === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    timerRunning: () => timer !== null,

    // The user opened Inbox or Calendar.
    onOpen() {
      if (stale(OPEN_FRESH_MS)) void syncNow();
    },

    // An agent task is about to read mail: at most `maxAge` old.
    async ensureFresh(maxAge = 5 * 60_000) {
      if (stale(maxAge)) await syncNow();
    },

    // Bodies for a thread's messages that don't have one cached yet, oldest first. Returns the first problem, if any,
    // so the thread view can say why a body is missing.
    async fetchBodies(messageIds: string[]): Promise<string | null> {
      const missing = messageIds
        .filter((id) => !(db.query("SELECT 1 FROM mail_bodies WHERE message_id = ?").get(id)))
        .slice(0, BODIES_PER_THREAD);
      let problem: string | null = null;
      for (const id of missing) {
        try {
          await withSource(id, async (source, account, msg) => {
            const body = await source.body(account, msg.sourceId);
            cacheBody(db, id, bodyText(body), now());
            if (body.attachments.length) {
              db.query("UPDATE mail_messages SET attachments = ?, has_attachments = 1 WHERE id = ?").run(JSON.stringify(body.attachments), id);
            }
          });
        } catch (e) {
          problem ??= message(e);
        }
      }
      return problem;
    },

    async saveAttachment(messageId: string, index: number): Promise<string> {
      return withSource(messageId, async (source, account, msg) => {
        const att = msg.attachments[index];
        if (!att) throw new MailProblem("other", "That attachment isn't on the message anymore.");
        return source.attachment(account, msg.sourceId, att, attachmentDir(messageId));
      });
    },

    // Turning Mail.app off forgets its accounts; their Google rows, if any, take over.
    appleOff(what: "mail" | "calendar") {
      write(db, APPLE_KEYS[what], null);
      write(db, PROBLEM_KEYS[what], null);
      if (what === "mail") removeSourceAccounts(db, "apple");
      else {
        db.query("DELETE FROM cal_events WHERE calendar_id IN (SELECT id FROM cal_calendars WHERE source = 'apple')").run();
        db.query("DELETE FROM cal_calendars WHERE source = 'apple'").run();
      }
      bus.emit({ type: "changed" });
    },
    appleOnNow(what: "mail" | "calendar") {
      write(db, APPLE_KEYS[what], "on");
      write(db, PROBLEM_KEYS[what], null);
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
