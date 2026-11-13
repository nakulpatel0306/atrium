import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "../engine/config";
import { logActivity } from "../engine/events";
import type { Mail } from "../engine/mail";
import { CLIENT_ID_KEY } from "../engine/mail/google/oauth";
import { openSaved } from "../engine/mail/files";
import { runPim } from "../engine/mail/pim";
import { getSetting, setSetting } from "../engine/settings";
import { inboxSpace, inboxSpaceId } from "../engine/mail/space";
import {
  getAccount,
  getThreadView,
  inviteForThread,
  listAccounts,
  listCalendars,
  listEvents,
  listThreads,
  removeAccount,
  setCalendarEnabled,
  setPreferred,
  threadMessages,
  updateAccount,
} from "../engine/mail/store";
import { appleOn, appleProblem, LIMITS, lastSyncedAt, mailSettings, SETTING_KEYS, type MailSettings } from "../engine/mail/sync";
import { MailProblem, type Person } from "../engine/mail/types";
import { AlreadyResolved, resolveApproval } from "../engine/approvals";
import { isEvent, type MailKind } from "../engine/mail/compose";
import { BadMail, draftEvent, draftMail, type EventEdit, getMailAction, type MailEdit, updateEventDraft, updateMailDraft } from "../engine/mail/drafts";
import { OPEN_IN_MAIL_COPY } from "../engine/mail/send";
import { ACCOUNT_COLORS } from "../engine/mail/colors";
import { KeychainError } from "../engine/markets/keychain";
import { HttpError, json, readBody } from "./http";

const DAY_MS = 86_400_000;
const GUIDE = join(import.meta.dir, "..", "..", "docs", "google-setup.md");
// System Settings panes for the two Apple permissions; opened only when the user presses the button.
const PANES = {
  automation: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
  calendars: "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars",
} as const;

export function mailOverview(db: Database, mail: Mail) {
  return {
    spaceId: inboxSpaceId(db),
    accounts: listAccounts(db),
    calendars: listCalendars(db),
    google: { clientId: getSetting(db, CLIENT_ID_KEY), connecting: mail.auth.pending(), lastError: getSetting(db, "mail.google.lastError") || null },
    apple: {
      installed: existsSync(config().pimBin),
      mail: appleOn(db, "mail"),
      mailProblem: appleProblem(db, "mail"),
      calendar: appleOn(db, "calendar"),
      calendarProblem: appleProblem(db, "calendar"),
    },
    settings: mailSettings(db),
    syncing: mail.sync.syncing(),
    syncedAt: lastSyncedAt(db),
  };
}
export type MailOverview = ReturnType<typeof mailOverview>;

const plain = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof MailProblem || e instanceof KeychainError) throw new HttpError(e instanceof MailProblem && e.kind === "signed_out" ? 401 : 502, e.message);
    throw e;
  }
};

const MAIL_KINDS: MailKind[] = ["reply", "reply_all", "forward", "new"];

// Whether the From on a card is an address whose preferred source is Mail.app, which never sends from Atrium.
function sendsThroughMail(db: Database, accountId: string | null): boolean {
  const picked = accountId ? getAccount(db, accountId) : null;
  return !!picked && listAccounts(db).some((a) => a.address === picked.address && a.preferred && a.source === "apple");
}

const optString = (v: unknown, field: string): string | null => {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new HttpError(400, `${field} must be text.`);
  return v;
};

// People as the card sends them: [{name, address}]. The addresses are checked by the draft rules.
function peopleOf(v: unknown): Person[] {
  if (!Array.isArray(v) || v.some((p) => !p || typeof p !== "object" || typeof p.address !== "string" || (p.name !== undefined && typeof p.name !== "string"))) {
    throw new HttpError(400, "People must be a list of {name, address}.");
  }
  return (v as { name?: string; address: string }[]).map((p) => ({ name: p.name ?? "", address: p.address }));
}

const mailEdit = (b: Record<string, unknown>): MailEdit => ({
  accountId: optString(b.accountId, "accountId") ?? "",
  to: peopleOf(b.to),
  cc: peopleOf(b.cc ?? []),
  subject: optString(b.subject, "subject") ?? "",
  body: optString(b.body, "body") ?? "",
});

const num = (v: unknown, field: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new HttpError(400, `${field} must be a time.`);
  return v;
};
const eventEdit = (b: Record<string, unknown>): EventEdit => ({
  calendarId: optString(b.calendarId, "calendarId") ?? "",
  title: optString(b.title, "title") ?? "",
  start: num(b.start, "start"),
  end: num(b.end, "end"),
  allDay: b.allDay === true,
  location: optString(b.location, "location") ?? "",
  attendees: peopleOf(b.attendees ?? []),
  notify: b.notify === true,
});

const nextHour = (now: number) => Math.ceil(now / 3600_000) * 3600_000;

const run = async (argv: string[]) => (await Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: { ...process.env } }).exited) === 0;

function guardedMail<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof AlreadyResolved) throw new HttpError(409, e.message);
    if (e instanceof BadMail) throw new HttpError(400, e.message);
    throw e;
  }
}
async function guardedMailAsync<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AlreadyResolved) throw new HttpError(409, e.message);
    if (e instanceof BadMail) throw new HttpError(400, e.message);
    throw e;
  }
}
const drafting = (fn: () => unknown) => guardedMail(() => json(fn()));

const int = (v: unknown, lo: number, hi: number, field: string): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) throw new HttpError(400, `${field} must be a whole number from ${lo} to ${hi}.`);
  return v;
};

// Mail and calendar: accounts and sources (Settings → Accounts, Get started), the Inbox and Calendar reads, and
// opening attachments, and the drafts and sends whose only trigger is the user's own press on a card. Returns null
// for paths it doesn't own.
export async function mailRoute(db: Database, mail: Mail, req: Request, url: URL): Promise<Response | null> {
  const { pathname } = url;
  const method = req.method;
  if (!pathname.startsWith("/api/mail")) return null;
  const hit = (m: string, pattern: RegExp) => (method === m ? pathname.match(pattern) : null);

  if (hit("GET", /^\/api\/mail$/)) return json(mailOverview(db, mail));

  // The Google setup guide from docs/, as plain text, so Get started and Settings can link to it.
  if (hit("GET", /^\/api\/mail\/guide$/)) {
    return new Response(Bun.file(GUIDE), { headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" } });
  }

  if (hit("POST", /^\/api\/mail\/setup$/)) return json({ spaceId: inboxSpace(db).id });

  if (hit("POST", /^\/api\/mail\/sync$/)) {
    const b = await readBody(req);
    if (b.force === true) void mail.sync.syncNow();
    else mail.sync.onOpen();
    return json({ syncing: mail.sync.syncing() });
  }

  if (hit("GET", /^\/api\/mail\/threads$/)) {
    const filter = url.searchParams.get("filter");
    return json({
      threads: listThreads(db, {
        accountId: url.searchParams.get("account") ?? undefined,
        filter: filter === "unread" || filter === "needs_reply" ? filter : undefined,
        search: url.searchParams.get("q")?.trim() || undefined,
      }),
    });
  }

  const threadM = hit("GET", /^\/api\/mail\/threads\/([^/]+)$/);
  if (threadM) {
    const thread = getThreadView(db, threadM[1]!);
    if (!thread) throw new HttpError(404, "That thread isn't in the Inbox anymore.");
    // A read only: what's cached, and whether bodies are still on their way. Opening the thread fetches them.
    const messages = threadMessages(db, thread.id);
    return json({ thread, messages, invite: inviteForThread(db, thread.id), ...mail.sync.bodyState(messages.map((m) => m.id)) });
  }

  const openM = hit("POST", /^\/api\/mail\/threads\/([^/]+)\/open$/);
  if (openM) {
    const thread = getThreadView(db, openM[1]!);
    if (!thread) throw new HttpError(404, "That thread isn't in the Inbox anymore.");
    const b = await readBody(req);
    const ids = threadMessages(db, thread.id).map((m) => m.id);
    // One message's own Retry names it; it must be on this thread.
    if (b.messageId !== undefined && (typeof b.messageId !== "string" || !ids.includes(b.messageId))) throw new HttpError(404, "That message isn't on this thread anymore.");
    // Fetched in the background; each body that lands is pushed to the dashboard.
    void mail.sync.fetchBodies(typeof b.messageId === "string" ? [b.messageId] : ids, { retry: b.retry === true });
    return json({ ok: true });
  }

  const attM = hit("POST", /^\/api\/mail\/messages\/([^/]+)\/attachments\/(\d+)\/open$/);
  if (attM) {
    const b = await readBody(req);
    const how = b.how === "reveal" ? "reveal" : "open";
    const path = await plain(() => mail.sync.saveAttachment(attM[1]!, Number(attM[2])));
    try {
      return json(await openSaved(path, how));
    } catch (e) {
      throw new HttpError(403, e instanceof Error ? e.message : String(e));
    }
  }

  // ---- Drafts and sends. Every send is the user's own press on a card; nothing here sends on anyone else's word.

  if (hit("POST", /^\/api\/mail\/drafts$/)) {
    const b = await readBody(req);
    if (!MAIL_KINDS.includes(b.kind as MailKind)) throw new HttpError(400, "kind must be reply, reply_all, forward or new.");
    const kind = b.kind as MailKind;
    const threadId = optString(b.threadId, "threadId");
    const messageId = optString(b.messageId, "messageId");
    if (kind !== "new") {
      const thread = threadId ? getThreadView(db, threadId) : null;
      if (!thread) throw new HttpError(404, "That thread isn't in the Inbox anymore.");
      // The message answered is quoted and its attachments forwarded, so its body is fetched first if it isn't yet.
      const ids = threadMessages(db, thread.id).map((m) => m.id);
      await mail.sync.fetchBodies(messageId && ids.includes(messageId) ? [messageId] : ids.slice(-1));
    }
    return drafting(() =>
      draftMail(db, { spaceId: inboxSpace(db).id, kind, draftedBy: "you", threadId, messageId, accountId: optString(b.accountId, "accountId"), to: peopleOf(b.to ?? []), cc: peopleOf(b.cc ?? []), subject: optString(b.subject, "subject") ?? "", body: optString(b.body, "body") ?? "" }).action,
    );
  }

  if (hit("POST", /^\/api\/mail\/event-drafts$/)) {
    const b = await readBody(req);
    if (b.kind !== "event_create" && b.kind !== "event_move" && b.kind !== "event_cancel") throw new HttpError(400, "kind must be event_create, event_move or event_cancel.");
    const kind = b.kind;
    const start = typeof b.start === "number" ? b.start : nextHour(Date.now());
    return drafting(() =>
      kind === "event_create"
        ? draftEvent(db, { spaceId: inboxSpace(db).id, kind, draftedBy: "you", calendarId: optString(b.calendarId, "calendarId"), title: optString(b.title, "title") || "New event", start, end: typeof b.end === "number" ? b.end : start + 3600_000 }).action
        : draftEvent(db, { spaceId: inboxSpace(db).id, kind, draftedBy: "you", eventId: optString(b.eventId, "eventId") }).action,
    );
  }

  const sendM = hit("POST", /^\/api\/mail\/actions\/([^/]+)\/send$/);
  if (sendM) {
    const action = getMailAction(db, sendM[1]!);
    if (!action) throw new HttpError(404, "That draft isn't there anymore.");
    const b = await readBody(req);
    if (!Array.isArray(b.seen) || b.seen.some((x) => typeof x !== "string")) throw new HttpError(400, "seen must list the keys of the notes the card showed.");
    // Only Google sends from the card; a Mail.app account's card opens the message in Mail instead.
    if (!isEvent(action.kind) && sendsThroughMail(db, typeof b.accountId === "string" ? b.accountId : action.accountId)) throw new HttpError(409, OPEN_IN_MAIL_COPY);
    const seen = new Set(b.seen as string[]);
    // His edits and his yes land together, so what goes out is what he saw when he pressed Send. A note the card
    // didn't show yet (his edit added someone new) keeps the edit but not the yes: he sees the note, then sends.
    const outcome = guardedMail(() =>
      db.transaction(() => {
        const next = isEvent(action.kind) ? updateEventDraft(db, action.id, eventEdit(b)) : updateMailDraft(db, action.id, mailEdit(b));
        const fresh = next.reasons.filter((r) => !seen.has(r.key));
        if (fresh.length) return { fresh };
        resolveApproval(db, next.approvalId, "approve");
        return { fresh: [] };
      })(),
    );
    if (outcome.fresh.length) throw new HttpError(409, `Check the card before sending: ${outcome.fresh.map((r) => r.text).join(". ")}. Then press Send again.`);
    return json(getMailAction(db, action.id));
  }

  const saveM = hit("POST", /^\/api\/mail\/actions\/([^/]+)\/save-draft$/);
  if (saveM) {
    const action = getMailAction(db, saveM[1]!);
    if (!action || isEvent(action.kind)) throw new HttpError(404, "That email draft isn't there anymore.");
    const b = await readBody(req);
    const edit = mailEdit(b);
    return json(await plain(() => guardedMailAsync(() => mail.actions.saveDraft(action.id, edit))));
  }

  const openMailM = hit("POST", /^\/api\/mail\/actions\/([^/]+)\/open-in-mail$/);
  if (openMailM) {
    const action = getMailAction(db, openMailM[1]!);
    if (!action || isEvent(action.kind)) throw new HttpError(404, "That email draft isn't there anymore.");
    const edit = mailEdit(await readBody(req));
    return json(await plain(() => guardedMailAsync(() => mail.actions.openInMail(action.id, edit))));
  }

  const archiveM = hit("POST", /^\/api\/mail\/threads\/([^/]+)\/archive$/);
  if (archiveM) {
    const b = await readBody(req);
    await plain(() => guardedMailAsync(() => mail.actions.archive(archiveM[1]!, b.undo === true)));
    return json({ ok: true });
  }

  // A Calendar.app event opens in Calendar, where the user changes or answers it himself.
  const calOpenM = hit("POST", /^\/api\/mail\/events\/([^/]+)\/open-in-calendar$/);
  if (calOpenM) {
    const e = db.query("SELECT e.source_id, c.source FROM cal_events e JOIN cal_calendars c ON c.id = e.calendar_id WHERE e.id = ?").get(calOpenM[1]!) as { source_id: string; source: string } | null;
    if (!e || e.source !== "apple") throw new HttpError(404, "That Calendar.app event isn't in the calendar anymore.");
    const id = e.source_id.split("|")[0]!;
    const opened = await run([config().openBin, `ical://ekevent/${encodeURIComponent(id)}?method=show&options=more`]);
    if (!opened && !(await run([config().openBin, "-b", "com.apple.iCal"]))) throw new HttpError(502, "Atrium couldn't open Calendar. Open it yourself to find the event.");
    return json({ ok: true });
  }

  const rsvpM = hit("POST", /^\/api\/mail\/events\/([^/]+)\/rsvp$/);
  if (rsvpM) {
    const b = await readBody(req);
    if (b.answer !== "accepted" && b.answer !== "tentative" && b.answer !== "declined") throw new HttpError(400, "answer must be accepted, tentative or declined.");
    const answer = b.answer;
    await plain(() => guardedMailAsync(() => mail.actions.rsvp(rsvpM[1]!, answer, optString(b.note, "note") ?? "")));
    return json({ ok: true });
  }

  if (hit("GET", /^\/api\/mail\/events$/)) {
    const from = Number(url.searchParams.get("from"));
    const to = Number(url.searchParams.get("to"));
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 120 * DAY_MS) throw new HttpError(400, "from and to must be a time range of up to 120 days.");
    return json({ events: listEvents(db, from, to) });
  }

  if (hit("POST", /^\/api\/mail\/google\/connect$/)) {
    const b = await readBody(req);
    if (typeof b.clientId !== "string") throw new HttpError(400, "Paste your Google OAuth client ID first.");
    const secret = typeof b.clientSecret === "string" ? b.clientSecret : undefined;
    const flow = await plain(() => mail.auth.start({ clientId: b.clientId as string, clientSecret: secret }));
    // The sign-in page opens in the user's browser; the link is returned too, in case it didn't.
    const proc = Bun.spawn([config().openBin, flow.url], { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: { ...process.env } });
    await proc.exited;
    void flow.done.then((r) => {
      if (!r.ok) setSetting(db, "mail.google.lastError", r.error);
      else setSetting(db, "mail.google.lastError", "");
    });
    return json({ url: flow.url });
  }

  if (hit("POST", /^\/api\/mail\/apple$/)) {
    const b = await readBody(req);
    if (b.what !== "mail" && b.what !== "calendar") throw new HttpError(400, "what must be mail or calendar.");
    const what = b.what;
    if (b.on === false) {
      mail.sync.appleOff(what);
      return json(mailOverview(db, mail));
    }
    // The dashboard said what macOS is about to ask before this call; the helper now asks it.
    await plain(() => runPim(["allow", what], { timeoutMs: 120_000 }));
    mail.sync.appleOnNow(what);
    const space = inboxSpace(db);
    logActivity(db, space.id, "atrium", what === "mail" ? "Started reading Apple Mail." : "Started reading Apple Calendar.");
    await mail.sync.syncNow();
    return json(mailOverview(db, mail));
  }

  if (hit("POST", /^\/api\/mail\/open-settings$/)) {
    const b = await readBody(req);
    const pane = b.pane === "calendars" ? PANES.calendars : PANES.automation;
    const proc = Bun.spawn([config().openBin, pane], { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: { ...process.env } });
    if ((await proc.exited) !== 0) throw new HttpError(502, "Atrium couldn't open System Settings. Open it yourself and go to Privacy & Security.");
    return json({ ok: true });
  }

  const accM = pathname.match(/^\/api\/mail\/accounts\/([^/]+)$/);
  if (accM && (method === "PATCH" || method === "DELETE")) {
    const account = getAccount(db, accM[1]!);
    if (!account) throw new HttpError(404, "That account isn't connected.");
    if (method === "DELETE") {
      if (account.source === "google") await plain(() => mail.auth.disconnect(account.id));
      removeAccount(db, account.id);
      const space = inboxSpaceId(db);
      if (space) logActivity(db, space, "atrium", `Disconnected ${account.address} (${account.source === "google" ? "Google" : "Mail.app"}) and removed its cached mail.`);
      return json(mailOverview(db, mail));
    }
    const b = await readBody(req);
    if (b.color !== undefined && (typeof b.color !== "string" || !ACCOUNT_COLORS.includes(b.color))) throw new HttpError(400, "Pick one of the listed colours.");
    if (b.enabled !== undefined && typeof b.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false.");
    if (b.preferred === true) setPreferred(db, account.id);
    updateAccount(db, account.id, { color: b.color as string | undefined, enabled: b.enabled as boolean | undefined });
    if (b.preferred === true || b.enabled === true) void mail.sync.syncNow();
    return json(mailOverview(db, mail));
  }

  const calM = hit("PATCH", /^\/api\/mail\/calendars\/([^/]+)$/);
  if (calM) {
    const b = await readBody(req);
    if (typeof b.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false.");
    setCalendarEnabled(db, calM[1]!, b.enabled);
    if (b.enabled) void mail.sync.syncNow();
    return json(mailOverview(db, mail));
  }

  if (hit("PUT", /^\/api\/mail\/settings$/)) {
    const b = await readBody(req);
    const next: Partial<MailSettings> = {};
    for (const k of Object.keys(SETTING_KEYS) as (keyof MailSettings)[]) {
      if (b[k] !== undefined) next[k] = int(b[k], LIMITS[k][0], LIMITS[k][1], k);
    }
    for (const [k, v] of Object.entries(next)) setSetting(db, SETTING_KEYS[k as keyof MailSettings], String(v));
    void mail.sync.syncNow();
    return json(mailOverview(db, mail));
  }

  return null;
}
