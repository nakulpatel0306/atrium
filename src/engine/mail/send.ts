import type { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Approval, getApproval, isOwnYes, resolveApproval, SAVED_DRAFT_NOTE } from "../approvals";
import { config } from "../config";
import { logActivity } from "../events";
import { hasHiddenText } from "../messaging/rules";
import { getTask, setTaskOutcome, setTaskStatus } from "../tasks";
import { isEvent, KIND_NOUN, namesLine, type Recipient } from "./compose";
import {
  BadMail,
  getMailAction,
  type MailAction,
  mailActionForApproval,
  type MailEdit,
  redraftMail,
  setMailStatus,
  updateMailDraft,
  writableCalendars,
} from "./drafts";
import { cacheBody } from "./body";
import { safeFileName } from "./files";
import { inboxSpaceId } from "./space";
import { newMessageId } from "./mime";
import { addSentCopy, getAccount, listAccounts, type MailAccount } from "./store";
import type { MailSync } from "./sync";
import { type AccountRef, MailProblem, type MailSource, type Outgoing, type Rsvp, type SourceAttachment } from "./types";

// The only path from a mail or calendar draft to the outside world: the user's own Send (or Approve) on its card,
// through the account's preferred source, at most once per draft. Modelled on messaging/send.ts.

export const REFUSED_COPY = "Only your own Send can send an email or change a calendar.";
export const STOPPED_COPY = "Atrium stopped while sending this. Check your Sent mail or calendar to see whether it went out before you send it again.";
export const NOT_STARTED_COPY = "Atrium stopped before sending this, so nothing went out. Press Send again when you're ready.";
export const SAVE_STOPPED_COPY = "Atrium stopped while saving this to your drafts. Check your drafts before saving it again.";
export const NOTE_COPY = "Keep the note to 500 characters, with no hidden characters.";

const ref = (a: MailAccount): AccountRef => ({ id: a.id, address: a.address, ref: a.ref });
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const people = (rs: Recipient[]) => rs.map(({ name, address }) => ({ name, address }));

export type MailActions = ReturnType<typeof createMailActions>;

export function createMailActions(deps: { db: Database; google: MailSource; apple: MailSource; sync?: Pick<MailSync, "syncNow">; now?: () => number }) {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const sourceOf = (kind: "google" | "apple") => (kind === "google" ? deps.google : deps.apple);
  const work = new Map<string, Promise<unknown>>();

  // One job per key; a second request for the same key joins the first.
  function track<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const running = work.get(key);
    if (running) return running as Promise<T>;
    const job = fn().finally(() => work.delete(key));
    work.set(key, job);
    return job;
  }

  // The row the address sends through now: its preferred one, whichever source that is. A crossover address has two
  // rows, and only this one is ever used, so it never sends twice.
  function sendingAccount(accountId: string | null): MailAccount {
    const picked = accountId ? getAccount(db, accountId) : null;
    const preferred = picked ? listAccounts(db).find((a) => a.address === picked.address && a.preferred) : null;
    if (!preferred) throw new MailProblem("other", "The account this was going to be sent from isn't connected anymore. Pick another From, then press Send.");
    return preferred;
  }

  function finishTask(taskId: string | null, outcome: "done" | "couldnt", reason: string): void {
    const task = taskId ? getTask(db, taskId) : null;
    if (!task) return;
    if (task.status === "review" || task.status === "blocked" || task.status === "failed" || task.status === "queued") setTaskStatus(db, task.id, "done");
    setTaskOutcome(db, task.id, outcome, reason);
  }

  // The forwarded message's files, saved for this send only from the source that holds that message.
  async function forwardedFiles(a: MailAction): Promise<{ dir: string | null; files: { name: string; path: string }[] }> {
    if (!a.attachments.length || !a.sourceMessageId) return { dir: null, files: [] };
    const row = db.query("SELECT account_id, source_id, attachments FROM mail_messages WHERE id = ?").get(a.sourceMessageId) as { account_id: string; source_id: string; attachments: string } | null;
    const holder = row ? getAccount(db, row.account_id) : null;
    if (!row || !holder) throw new MailProblem("other", "The forwarded message isn't in the Inbox anymore, so its attachments can't go with it. Sync, then forward it again.");
    const stored = JSON.parse(row.attachments) as SourceAttachment[];
    const dir = join(config().home, "mail-outgoing", a.id);
    mkdirSync(dir, { recursive: true });
    const files: { name: string; path: string }[] = [];
    for (const att of a.attachments) {
      const s = stored[att.index];
      if (!s) throw new MailProblem("other", `The attachment ${safeFileName(att.name)} isn't on the message anymore.`);
      files.push({ name: safeFileName(s.name), path: await sourceOf(holder.source).attachment(ref(holder), row.source_id, s, dir) });
    }
    return { dir, files };
  }

  async function sendEmail(a: MailAction): Promise<string> {
    const account = sendingAccount(a.accountId);
    const source = sourceOf(account.source);
    // Gmail's threadId and Mail.app's reply both need the thread's own account row; otherwise the headers thread it.
    const sameRow = account.id === a.threadAccountId;
    const answered = a.sourceMessageId && sameRow && a.kind !== "forward" ? (db.query("SELECT source_id FROM mail_messages WHERE id = ?").get(a.sourceMessageId) as { source_id: string } | null) : null;
    const { dir, files } = await forwardedFiles(a);
    try {
      const out: Outgoing = {
        from: { name: account.name, address: account.address },
        to: people(a.to),
        cc: people(a.cc),
        subject: a.subject,
        text: a.quoted ? `${a.body}\n\n${a.quoted}` : a.body,
        messageId: newMessageId(account.address),
        inReplyTo: a.inReplyTo,
        references: a.references,
        threadKey: account.source === "google" && sameRow ? a.gmailThreadId : null,
        replyToSourceId: account.source === "apple" ? (answered?.source_id ?? null) : null,
        attachments: files,
      };
      const sent = await source.send(ref(account), out);
      const at = now();
      const copy = addSentCopy(db, account, a.id, {
        sourceId: sent.sourceId ?? `atrium-sent:${a.id}`,
        threadKey: sent.threadKey ?? undefined,
        messageId: account.source === "google" ? out.messageId : null,
        inReplyTo: out.inReplyTo,
        references: out.references,
        subject: out.subject,
        from: out.from,
        to: out.to,
        cc: out.cc,
        date: at,
        snippet: a.body.replace(/\s+/g, " ").trim().slice(0, 200),
        unread: false,
        labels: [],
        attachments: files.map((f, i) => ({ name: f.name, size: a.attachments[i]?.size ?? 0, ref: f.name })),
      });
      cacheBody(db, copy, out.text, at);
      return account.address;
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  }

  async function applyEvent(a: MailAction): Promise<void> {
    const e = a.event!;
    if (!writableCalendars(db).some((c) => c.id === e.calendarId)) throw new MailProblem("other", "That calendar isn't available to Atrium anymore. Pick another one, then approve again.");
    const cal = db.query("SELECT source, source_id, account_id FROM cal_calendars WHERE id = ?").get(e.calendarId) as { source: "google" | "apple"; source_id: string; account_id: string | null };
    const holder = cal.account_id ? getAccount(db, cal.account_id) : null;
    const account = holder ? ref(holder) : null;
    const source = sourceOf(cal.source);
    if (a.kind === "event_create") {
      await source.createEvent(account, cal.source_id, { title: e.title, start: e.start, end: e.end, allDay: e.allDay, location: e.location, attendees: people(e.attendees) }, e.attendees.length > 0);
      void deps.sync?.syncNow();
      return;
    }
    const stored = db.query("SELECT source_id FROM cal_events WHERE id = ?").get(e.eventId ?? "") as { source_id: string } | null;
    if (!stored) throw new MailProblem("other", "That event isn't in the calendar anymore. Sync, then try again.");
    if (a.kind === "event_move") {
      await source.moveEvent(account, cal.source_id, stored.source_id, e.start, e.end, e.notify);
      db.query("UPDATE cal_events SET start_at = ?, end_at = ? WHERE id = ?").run(e.start, e.end, e.eventId);
    } else {
      await source.cancelEvent(account, cal.source_id, stored.source_id, e.notify);
      db.query("DELETE FROM cal_events WHERE id = ?").run(e.eventId);
    }
  }

  const what = (a: MailAction) => (isEvent(a.kind) ? `"${a.event?.title}"` : `the ${KIND_NOUN[a.kind]} to ${namesLine(a.to)}`);

  // Runs only after the user's own yes, and at most once per draft: the draft → sending move is guarded, so a second
  // yes, a second app or a direct call finds it already taken and does nothing.
  async function send(id: string): Promise<MailAction> {
    const a = getMailAction(db, id);
    if (!a) throw new Error(`No mail draft with id ${id}`);
    if (a.status !== "draft") return a;
    const approval = getApproval(db, a.approvalId);
    if (approval?.status === "pending") return a;
    if (!approval || !isOwnYes(approval) || approval.alwaysAsk !== "send_message") {
      logActivity(db, a.spaceId, "atrium", `Didn't send ${what(a)}: ${REFUSED_COPY}`, { taskId: a.taskId });
      return setMailStatus(db, a.id, "failed", { error: REFUSED_COPY });
    }
    try {
      setMailStatus(db, a.id, "sending");
    } catch {
      return getMailAction(db, a.id)!;
    }
    try {
      let line: string;
      if (isEvent(a.kind)) {
        await applyEvent(a);
        const e = a.event!;
        line =
          a.kind === "event_create"
            ? `Created "${e.title}"${e.attendees.length ? ` and invited ${namesLine(e.attendees)}` : ""}.`
            : `${a.kind === "event_move" ? "Moved" : "Cancelled"} "${e.title}"${e.notify ? " and told its guests" : ""}.`;
      } else {
        const from = await sendEmail(a);
        line = `Sent ${what(a)} from ${from}.`;
      }
      const sent = setMailStatus(db, a.id, "sent", { sentAt: now() });
      logActivity(db, a.spaceId, "atrium", line, { taskId: a.taskId });
      finishTask(a.taskId, "done", line);
      return sent;
    } catch (e) {
      const problem = e instanceof MailProblem || e instanceof BadMail ? e.message : "Something went wrong before it went out. Check the card, then press Send again.";
      if (!(e instanceof MailProblem || e instanceof BadMail)) console.error(`Mail send ${a.id} failed: ${message(e)}`);
      const failed = setMailStatus(db, a.id, "failed", { error: problem });
      logActivity(db, a.spaceId, "atrium", `Couldn't send ${what(a)}: ${problem}`, { taskId: a.taskId });
      redraftMail(db, failed, problem);
      return failed;
    }
  }

  function reject(id: string): void {
    const a = getMailAction(db, id);
    if (a?.status !== "draft") return;
    setMailStatus(db, a.id, "rejected");
    finishTask(a.taskId, "couldnt", "You chose not to send it.");
  }

  return {
    // Wired to onApprovalResolved: the user's Send approves the draft's approval, and this sends it.
    onDecision(a: Approval, d: "approve" | "reject"): void {
      if (a.alwaysAsk !== "send_message") return;
      const action = mailActionForApproval(db, a.id);
      if (action?.status !== "draft") return;
      if (d === "reject") return reject(action.id);
      track(`send:${action.id}`, () => send(action.id)).catch((e) => console.error(`Sending ${action.id} failed: ${message(e)}`));
    },

    send,

    // "Save as draft": the user's edits, then the same message into Gmail Drafts or Mail.app's Drafts. Nothing is
    // sent. The card closes once it's saved; if the source can't save it, it stays a draft with the reason.
    saveDraft(id: string, edit: MailEdit): Promise<MailAction> {
      return track(`save:${id}`, async () => {
        updateMailDraft(db, id, edit);
        const a = setMailStatus(db, id, "saving");
        try {
          const account = sendingAccount(a.accountId);
          const { dir, files } = await forwardedFiles(a);
          try {
            await sourceOf(account.source).saveDraft(ref(account), {
              from: { name: account.name, address: account.address },
              to: people(a.to),
              cc: people(a.cc),
              subject: a.subject,
              text: a.quoted ? `${a.body}\n\n${a.quoted}` : a.body,
              messageId: newMessageId(account.address),
              inReplyTo: a.inReplyTo,
              references: a.references,
              threadKey: account.source === "google" && account.id === a.threadAccountId ? a.gmailThreadId : null,
              replyToSourceId: null,
              attachments: files,
            });
          } finally {
            if (dir) rmSync(dir, { recursive: true, force: true });
          }
          const saved = setMailStatus(db, id, "saved");
          resolveApproval(db, a.approvalId, "reject", SAVED_DRAFT_NOTE);
          const where = account.source === "google" ? "Gmail Drafts" : "Mail's Drafts";
          logActivity(db, a.spaceId, "atrium", `Saved ${what(a)} to ${where}.`, { taskId: a.taskId });
          finishTask(a.taskId, "couldnt", `Saved to ${where} for you to finish. It isn't sent.`);
          return saved;
        } catch (e) {
          setMailStatus(db, id, "draft", { error: null });
          throw e instanceof MailProblem || e instanceof BadMail ? e : new MailProblem("other", "Atrium couldn't save it to your drafts. Try again.");
        }
      });
    },

    // The user's own answer to an invitation, from Inbox or Calendar. One answer at a time per event.
    rsvp(eventId: string, answer: Rsvp, note: string): Promise<void> {
      return track(`rsvp:${eventId}`, async () => {
        if (note.length > 500 || hasHiddenText(note.replace(/\n/g, " "))) throw new BadMail(NOTE_COPY);
        const e = db.query("SELECT e.source_id, e.title, c.source, c.source_id AS cal_source_id, c.account_id FROM cal_events e JOIN cal_calendars c ON c.id = e.calendar_id WHERE e.id = ?").get(eventId) as
          | { source_id: string; title: string; source: "google" | "apple"; cal_source_id: string; account_id: string | null }
          | null;
        if (!e) throw new BadMail("That event isn't in the calendar anymore. Sync, then try again.");
        const holder = e.account_id ? getAccount(db, e.account_id) : null;
        await sourceOf(e.source).rsvp(holder ? ref(holder) : null, e.cal_source_id, e.source_id, answer, note);
        db.query("UPDATE cal_events SET my_status = ? WHERE id = ?").run(answer, eventId);
        logActivity(db, inboxSpaceId(db), "you", `Answered "${e.title}": ${ANSWER_WORD[answer]}.`);
      });
    },

    async settle() {
      while (work.size > 0) await Promise.allSettled([...work.values()]);
    },
  };
}

const ANSWER_WORD: Record<Rsvp, string> = { accepted: "going", tentative: "maybe", declined: "not going" };

// Never sends. A send cut off mid-way may or may not have gone out, so it comes back as a draft that says so; a yes
// that never reached the source comes back as a draft too, since nothing resends on its own.
export function recoverMailActions(db: Database): number {
  const rows = db
    .query(
      `SELECT m.id, m.status, a.status AS decided FROM mail_actions m JOIN approvals a ON a.id = m.approval_id
       WHERE m.status IN ('sending','saving') OR (m.status = 'draft' AND a.status != 'pending')`,
    )
    .all() as { id: string; status: string; decided: string }[];
  for (const r of rows) {
    if (r.status === "saving") {
      setMailStatus(db, r.id, "draft", { error: SAVE_STOPPED_COPY });
      continue;
    }
    if (r.status === "draft" && r.decided === "rejected") {
      setMailStatus(db, r.id, "rejected");
      continue;
    }
    const error = r.status === "sending" ? STOPPED_COPY : NOT_STARTED_COPY;
    const failed = setMailStatus(db, r.id, "failed", { error });
    redraftMail(db, failed, error);
  }
  return rows.length;
}
