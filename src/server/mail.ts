import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { config } from "../engine/config";
import { logActivity } from "../engine/events";
import type { Mail } from "../engine/mail";
import { CLIENT_ID_KEY } from "../engine/mail/google/oauth";
import { openSaved } from "../engine/mail/files";
import { runPim } from "../engine/mail/pim";
import { getSetting, setSetting } from "../engine/settings";
import { inboxSpace, inboxSpaceId } from "../engine/mail/space";
import {
  ACCOUNT_COLORS,
  getAccount,
  getThreadView,
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
import { MailProblem } from "../engine/mail/types";
import { KeychainError } from "../engine/markets/keychain";
import { HttpError, json, readBody } from "./http";

const DAY_MS = 86_400_000;
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

const int = (v: unknown, lo: number, hi: number, field: string): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) throw new HttpError(400, `${field} must be a whole number from ${lo} to ${hi}.`);
  return v;
};

// Mail and calendar: accounts and sources (Settings → Accounts, Get started), the Inbox and Calendar reads, and
// opening attachments. Nothing here sends anything. Returns null for paths it doesn't own.
export async function mailRoute(db: Database, mail: Mail, req: Request, url: URL): Promise<Response | null> {
  const { pathname } = url;
  const method = req.method;
  if (!pathname.startsWith("/api/mail")) return null;
  const hit = (m: string, pattern: RegExp) => (method === m ? pathname.match(pattern) : null);

  if (hit("GET", /^\/api\/mail$/)) return json(mailOverview(db, mail));

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
    const problem = await mail.sync.fetchBodies(threadMessages(db, thread.id).map((m) => m.id));
    return json({ thread, messages: threadMessages(db, thread.id), problem });
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
    void proc.exited;
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
