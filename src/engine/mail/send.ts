import type { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Approval, getApproval, isOwnYes, OPENED_IN_MAIL_NOTE, resolveApproval, SAVED_DRAFT_NOTE } from "../approvals";
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
  sendingRow,
  APPLE_EVENT_COPY,
  setMailStatus,
  updateMailDraft,
  writableCalendars,
} from "./drafts";
import { cacheBody } from "./body";
import { safeFileName } from "./files";
import { inboxSpaceId } from "./space";
import { newMessageId } from "./mime";
import { addSentCopy, getAccount, listAccounts, type MailAccount, setArchived } from "./store";
import type { MailSync } from "./sync";
import { type AccountRef, MailProblem, type MailSource, type Outgoing, type Rsvp, type Sent, type SourceAttachment } from "./types";

// The only path from a mail or calendar draft to the outside world: the user's own Send (or Approve) on its card,
// through the account's preferred source, at most once per draft. Modelled on messaging/send.ts.

export const REFUSED_COPY = "Only your own Send can send an email or change a calendar.";
export const STOPPED_COPY = "Atrium stopped while sending this. Check your Sent mail or calendar to see whether it went out before you send it again.";
export const NOT_STARTED_COPY = "Atrium stopped before sending this, so nothing went out. Press Send again when you're ready.";
export const SAVE_STOPPED_COPY = "Atrium stopped while saving this to your drafts. Check your drafts before saving it again.";
export const NOTE_COPY = "Keep the note to 500 characters, with no hidden characters.";
export const OPEN_IN_MAIL_COPY = "This account sends from Mail. Press Open in Mail, then send it there.";
export const NO_RSVP_COPY = "Answer Calendar.app invitations in Calendar.";

export const UNSURE_COPY = "This may have gone out. Check your Sent mail or calendar before sending it again.";
export const NOTHING_SENT_COPY = "Something went wrong before it went out, so nothing was sent. Check the card, then press Send again.";

const ref = (a: MailAccount): AccountRef => ({ id: a.id, address: a.address, ref: a.ref });
// For the engine log: what kind of error, never its message, which can carry a file or attachment name.
const errorKind = (e: unknown) => (e instanceof Error ? `${e.name}${(e as { code?: unknown }).code ? ` ${String((e as { code?: unknown }).code)}` : ""}` : typeof e);

// A write the source doesn't offer is a plain refusal, made before anything is sent.
function need<F>(fn: F | undefined): F {
  if (!fn) throw new BadMail("That account's source can't do this.");
  return fn;
}

// An error from the source call itself, after which the message may have gone out.
class Delivery extends Error {
  constructor(override readonly cause: unknown) {
    super("delivery");
    this.name = "Delivery";
  }
}
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

  function sendingAccount(accountId: string | null): MailAccount {
    const preferred = sendingRow(db, accountId);
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

  // Threading for the row that sends. The thread's own row has it stored; after a source switch the same message is
  // found again under the new row by its Message-ID, so a reply still threads.
  function threading(a: MailAction, account: MailAccount): { threadKey: string | null; replyTo: string | null } {
    if (a.kind === "forward") return { threadKey: null, replyTo: null };
    if (account.id === a.threadAccountId) {
      const answered = a.sourceMessageId ? (db.query("SELECT source_id FROM mail_messages WHERE id = ?").get(a.sourceMessageId) as { source_id: string } | null) : null;
      return { threadKey: account.source === "google" ? a.gmailThreadId : null, replyTo: account.source === "apple" ? (answered?.source_id ?? null) : null };
    }
    const same = a.inReplyTo
      ? (db.query("SELECT m.source_id, t.thread_key FROM mail_messages m JOIN mail_threads t ON t.id = m.thread_id WHERE m.account_id = ? AND m.message_id = ? LIMIT 1").get(account.id, a.inReplyTo) as { source_id: string; thread_key: string } | null)
      : null;
    if (!same) return { threadKey: null, replyTo: null };
    return { threadKey: account.source === "google" ? same.thread_key : null, replyTo: account.source === "apple" ? same.source_id : null };
  }

  // The email exactly as the card holds it, with the threading the sending row can use.
  function outgoing(a: MailAction, account: MailAccount, files: { name: string; path: string }[]): Outgoing {
    const { threadKey, replyTo } = threading(a, account);
    return {
      from: { name: account.name, address: account.address },
      to: people(a.to),
      cc: people(a.cc),
      subject: a.subject,
      text: a.quoted ? `${a.body}\n\n${a.quoted}` : a.body,
      messageId: newMessageId(account.address),
      inReplyTo: a.inReplyTo,
      references: a.references,
      threadKey,
      replyToSourceId: replyTo,
      attachments: files,
    };
  }

  // The Google account an email goes out through: Atrium sends only through Google. A Mail.app account's card opens
  // the message in Mail instead.
  function googleAccount(a: MailAction): MailAccount {
    const account = sendingAccount(a.accountId);
    if (account.source !== "google") throw new BadMail(OPEN_IN_MAIL_COPY);
    return account;
  }

  // Hands the email to Gmail. Returns once Gmail has taken it, with what to record afterwards; anything the call itself
  // throws comes back wrapped in Delivery, since by then it may have gone out.
  async function sendEmail(a: MailAction): Promise<{ line: string; record(): void }> {
    const account = googleAccount(a);
    const { dir, files } = await forwardedFiles(a);
    try {
      const out = outgoing(a, account, files);
      let sent: Sent;
      try {
        sent = await need(deps.google.send)(ref(account), out);
      } catch (e) {
        throw new Delivery(e);
      }
      const record = () => {
        const at = now();
        const copy = addSentCopy(db, account, a.id, {
          sourceId: sent.sourceId ?? `atrium-sent:${a.id}`,
          threadKey: sent.threadKey ?? undefined,
          messageId: out.messageId,
          inReplyTo: out.inReplyTo,
          references: out.references,
          subject: out.subject,
          from: out.from,
          to: out.to,
          cc: out.cc,
          date: at,
          snippet: a.body.replace(/\s+/g, " ").trim().slice(0, 200),
          unread: false,
          sent: true,
          labels: [],
          attachments: files.map((f, i) => ({ name: f.name, size: a.attachments[i]?.size ?? 0, ref: f.name })),
        });
        cacheBody(db, copy, out.text, at);
      };
      return { line: `Sent ${what(a)} from ${account.address}.`, record };
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  }

  async function applyEvent(a: MailAction): Promise<{ line: string; record(): void }> {
    const e = a.event!;
    if (!writableCalendars(db).some((c) => c.id === e.calendarId)) throw new MailProblem("other", "That calendar isn't available to Atrium anymore. Pick another one, then approve again.");
    const cal = db.query("SELECT source, source_id, account_id FROM cal_calendars WHERE id = ?").get(e.calendarId) as { source: "google" | "apple"; source_id: string; account_id: string | null };
    const holder = cal.account_id ? getAccount(db, cal.account_id) : null;
    const account = holder ? ref(holder) : null;
    const source = sourceOf(cal.source);
    if (a.kind !== "event_create" && cal.source !== "google") throw new BadMail(APPLE_EVENT_COPY);
    const deliver = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (e) {
        throw new Delivery(e);
      }
    };
    if (a.kind === "event_create") {
      await deliver(() => source.createEvent(account, cal.source_id, { title: e.title, start: e.start, end: e.end, allDay: e.allDay, location: e.location, attendees: people(e.attendees) }, e.attendees.length > 0));
      return { line: `Created "${e.title}"${e.attendees.length ? ` and invited ${namesLine(e.attendees)}` : ""}.`, record: () => void deps.sync?.syncNow() };
    }
    const stored = db.query("SELECT source_id FROM cal_events WHERE id = ?").get(e.eventId ?? "") as { source_id: string } | null;
    if (!stored) throw new MailProblem("other", "That event isn't in the calendar anymore. Sync, then try again.");
    const told = e.notify ? " and told its guests" : "";
    if (a.kind === "event_move") {
      await deliver(() => need(source.moveEvent)(account, cal.source_id, stored.source_id, e.start, e.end, e.notify));
      return { line: `Moved "${e.title}"${told}.`, record: () => void db.query("UPDATE cal_events SET start_at = ?, end_at = ? WHERE id = ?").run(e.start, e.end, e.eventId) };
    }
    await deliver(() => need(source.cancelEvent)(account, cal.source_id, stored.source_id, e.notify));
    return { line: `Cancelled "${e.title}"${told}.`, record: () => void db.query("DELETE FROM cal_events WHERE id = ?").run(e.eventId) };
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
    let done: { line: string; record(): void };
    try {
      done = isEvent(a.kind) ? await applyEvent(a) : await sendEmail(a);
    } catch (e) {
      return failedSend(a, e);
    }
    // The source took it: it's sent, whatever happens to the bookkeeping after this.
    const sent = setMailStatus(db, a.id, "sent", { sentAt: now() });
    try {
      done.record();
    } catch (e) {
      console.error(`Mail send ${a.id}: went out, but its record in Atrium failed (${errorKind(e)}).`);
    }
    logActivity(db, a.spaceId, "atrium", done.line, { taskId: a.taskId });
    finishTask(a.taskId, "done", done.line);
    return sent;
  }

  // Before the source call, or a source that says plainly it didn't send: the card comes back with the reason. A
  // source call that may have gone through is "unsure": no card comes back, so nothing invites a second send.
  function failedSend(a: MailAction, e: unknown): MailAction {
    const inner = e instanceof Delivery ? e.cause : e;
    const plain = inner instanceof MailProblem || inner instanceof BadMail;
    const unsure = e instanceof Delivery && (!plain || (inner instanceof MailProblem && inner.kind === "unsure"));
    if (!plain) console.error(`Mail send ${a.id} failed (${errorKind(inner)}).`);
    if (unsure) {
      const copy = inner instanceof MailProblem ? inner.message : UNSURE_COPY;
      const left = setMailStatus(db, a.id, "unsure", { error: copy });
      logActivity(db, a.spaceId, "atrium", `Not sure whether ${what(a)} went out: ${copy}`, { taskId: a.taskId });
      finishTask(a.taskId, "couldnt", copy);
      return left;
    }
    const problem = plain ? (inner as Error).message : NOTHING_SENT_COPY;
    const failed = setMailStatus(db, a.id, "failed", { error: problem });
    logActivity(db, a.spaceId, "atrium", `Couldn't send ${what(a)}: ${problem}`, { taskId: a.taskId });
    redraftMail(db, failed, problem);
    return failed;
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
      track(`send:${action.id}`, () => send(action.id)).catch((e) => console.error(`Sending ${action.id} failed (${errorKind(e)}).`));
    },

    send,

    // "Save as draft": the user's edits, then the same message into Gmail Drafts. Nothing is sent. The card closes once
    // it's saved; if Gmail can't save it, it stays a draft with the reason.
    saveDraft(id: string, edit: MailEdit): Promise<MailAction> {
      return track(`save:${id}`, async () => {
        const edited = updateMailDraft(db, id, edit);
        const account = googleAccount(edited);
        const a = setMailStatus(db, id, "saving");
        try {
          const { dir, files } = await forwardedFiles(a);
          try {
            await need(deps.google.saveDraft)(ref(account), outgoing(a, account, files));
          } finally {
            if (dir) rmSync(dir, { recursive: true, force: true });
          }
          const saved = setMailStatus(db, id, "saved");
          resolveApproval(db, a.approvalId, "reject", SAVED_DRAFT_NOTE);
          logActivity(db, a.spaceId, "atrium", `Saved ${what(a)} to Gmail Drafts.`, { taskId: a.taskId });
          finishTask(a.taskId, "couldnt", "Saved to Gmail Drafts for you to finish. It isn't sent.");
          return saved;
        } catch (e) {
          setMailStatus(db, id, "draft", { error: null });
          throw e instanceof MailProblem || e instanceof BadMail ? e : new MailProblem("other", "Atrium couldn't save it to your drafts. Try again.");
        }
      });
    },

    // "Open in Mail", the card's button for a Mail.app account: the message opens filled in, in a visible Mail window,
    // and the user sends it from there. Atrium never sends through Mail.app, so the card closes as opened, not sent.
    // The forwarded files stay where Mail can attach them until the engine next starts.
    openInMail(id: string, edit: MailEdit): Promise<MailAction> {
      return track(`open:${id}`, async () => {
        const a = updateMailDraft(db, id, edit);
        const account = sendingAccount(a.accountId);
        if (account.source !== "apple") throw new BadMail("This account sends from the card. Press Send.");
        const { files } = await forwardedFiles(a);
        await need(deps.apple.compose)(ref(account), outgoing(a, account, files));
        const opened = setMailStatus(db, id, "opened");
        resolveApproval(db, a.approvalId, "reject", OPENED_IN_MAIL_NOTE);
        logActivity(db, a.spaceId, "atrium", `Opened ${what(a)} in Mail for you to send.`, { taskId: a.taskId });
        finishTask(a.taskId, "couldnt", "Opened in Mail. Send it from there.");
        return opened;
      });
    },

    // Gmail archive, or with `undo` back to the inbox. Atrium hides the thread at once; new mail on it brings it back.
    archive(threadId: string, undo: boolean): Promise<void> {
      return track(`archive:${threadId}`, async () => {
        const t = db.query("SELECT t.thread_key, a.* FROM mail_threads t JOIN mail_accounts a ON a.id = t.account_id WHERE t.id = ?").get(threadId) as { thread_key: string; id: string; address: string; source: string; source_ref: string | null } | null;
        if (!t) throw new BadMail("That thread isn't in the Inbox anymore.");
        if (t.source !== "google") throw new BadMail("Archive works for Google accounts. Archive this one in Mail.");
        await need(deps.google.archive)({ id: t.id, address: t.address, ref: t.source_ref }, t.thread_key, undo);
        setArchived(db, threadId, !undo, now());
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
        const rsvp = sourceOf(e.source).rsvp;
        if (!rsvp) throw new BadMail(NO_RSVP_COPY);
        await rsvp(holder ? ref(holder) : null, e.cal_source_id, e.source_id, answer, note);
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
  // Forwarded attachments saved for a send that never finished; each send makes its own again.
  rmSync(join(config().home, "mail-outgoing"), { recursive: true, force: true });
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
