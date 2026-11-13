import { config } from "../config";
import { MailProblem, type MailProblemKind } from "./types";

// The only place Atrium runs atrium-pim, the Swift helper that reads Mail.app (through AppleScript) and Calendar.app
// (through EventKit). Always an argv array, never a shell. Each call prints one JSON document on stdout.
//
// Interface (pinned here and in mac/Sources/Pim/main.swift; tests/fixtures/fake-pim.ts plays it in tests):
//
//   atrium-pim status
//     → {"mail": "allowed"|"denied"|"not_determined"|"not_running", "calendar": "full"|"denied"|"not_determined"|"write_only"|"restricted"}
//     Never shows a permission prompt.
//   atrium-pim allow mail|calendar
//     → {"ok": true}  Asks macOS for the permission (the prompt the dashboard announced first). Whom macOS names in
//     that prompt (bun, the engine, or atrium-pim) depends on how the helper was launched, so no copy promises one.
//   atrium-pim mail.accounts
//     → {"accounts": [{"id": string, "name": string, "addresses": [string], "fullName": string}]}
//   atrium-pim mail.messages --account <id> --since <ISO 8601>
//     → {"messages": [{"id": string, "messageId": string|null, "inReplyTo": string|null, "references": string|null,
//         "subject": string, "from": string, "to": string, "cc": string, "date": ISO, "read": bool,
//         "snippet": "", "attachments": [{"name": string, "size": number}]}]}
//     Headers only, never content: the newest 300 of the account's Inbox and the newest 200 of its Sent, each cut
//     separately. snippet is always empty (the engine takes it from the body once fetched). id is opaque: pass it
//     back to mail.message and mail.attachment. from/to/cc are raw header text ("Name <a@b>", RFC 2047 words
//     included), decoded by the engine.
//   atrium-pim mail.message --id <id>
//     The body is read here only.
//     → {"message": {"text": string|null, "html": string|null, "attachments": [{"name": string, "size": number}]}}
//   atrium-pim mail.attachment --id <id> --name <name> --out <dir>
//     → {"path": string}
//   atrium-pim cal.calendars
//     → {"calendars": [{"id": string, "title": string, "color": "#rrggbb", "writable": bool, "source": string, "account": string|null}]}
//   atrium-pim cal.events --calendar <id> --from <ISO> --to <ISO>
//     → {"events": [{"id": string, "icalUid": string, "recurrenceId": ISO|null, "title": string, "start": ISO, "end": ISO,
//         "allDay": bool, "location": string, "attendees": [{"name": string, "email": string, "status": string|null}],
//         "organizer": string|null, "myStatus": "accepted"|"declined"|"tentative"|"needs_action"|null, "recurrence": string|null}]}
//
// The write commands read one JSON document on stdin, never argv, so no address or word of the email shows in the
// process list. Each runs once per user action; the engine never retries one on its own.
//
//   atrium-pim mail.send     stdin {"account": string, "from": string, "to": [{"name", "address"}], "cc": [...],
//                                  "subject": string, "text": string, "replyTo": id|null, "attachments": [path]}
//     → {"ok": true}  Sends through Mail.app from that account. With replyTo (an id from mail.messages) it answers that
//     message, so Mail sets In-Reply-To and References itself; the recipients are then replaced by exactly these.
//   atrium-pim mail.draft    stdin as mail.send
//     → {"ok": true}  Saves the same message to that account's Drafts instead of sending it.
//   atrium-pim cal.create    stdin {"calendar": string, "title": string, "start": ISO, "end": ISO, "allDay": bool, "location": string}
//     → {"event": {"id": string}}  No guests: EventKit can't invite people for another app.
//   atrium-pim cal.update    stdin {"id": string, "start": ISO, "end": ISO}
//     → {"ok": true}  Moves that one occurrence (id as cal.events gives it).
//   atrium-pim cal.delete    stdin {"id": string}
//     → {"ok": true}  Removes that one occurrence.
//   There is no cal.rsvp: EventKit can't answer an invitation for another app. The engine says so instead.
//
// Failure: a non-zero exit and {"error": {"kind": "automation_denied"|"calendar_denied"|"not_running"|"bad_args"|"not_found"|"other", "message": string}}.

export const PIM_COPY = {
  not_installed: "Atrium's Mail and Calendar helper isn't installed. Run atrium app install in Terminal, then try again.",
  // macOS may list the permission under Atrium's engine ("bun") or its helper ("atrium-pim"), so neither is promised.
  automation_denied:
    "Atrium isn't allowed to read Mail yet. Open System Settings › Privacy & Security › Automation, turn on Mail under Atrium's engine (it may be listed as bun or atrium-pim), then press Sync.",
  calendar_denied:
    "Atrium isn't allowed to read your calendars yet. Open System Settings › Privacy & Security › Calendars, turn on Atrium's engine (it may be listed as bun or atrium-pim), then press Sync.",
  timeout: "Mail or Calendar didn't answer in time. If macOS is asking for permission, answer that dialog, then press Sync.",
  not_running: "Mail isn't open, so Atrium couldn't read it. Open Mail, then press Sync.",
  other: "Mail or Calendar didn't answer, and Atrium couldn't tell why. Check that both open normally, then press Sync.",
  not_found: "Mail or Calendar couldn't find that message or event anymore. Sync, then try again.",
} as const;

// A write that timed out may still have gone through.
export const PIM_UNSURE_COPY = "Mail or Calendar didn't answer in time, so Atrium can't tell whether this went through. Check Mail's Sent mailbox or Calendar before trying again.";

const KINDS: Record<string, MailProblemKind> = { automation_denied: "automation_denied", calendar_denied: "calendar_denied", not_running: "other" };

// `input` is a write command's JSON document, given on stdin.
export async function runPim<T>(args: string[], opts: { timeoutMs?: number; input?: unknown } = {}): Promise<T> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    const stdin = opts.input === undefined ? "ignore" : new Blob([JSON.stringify(opts.input)]);
    proc = Bun.spawn([config().pimBin, ...args], { stdin, stdout: "pipe", stderr: "pipe", env: { ...process.env } });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "EACCES") throw new MailProblem("not_installed", PIM_COPY.not_installed);
    throw e;
  }
  let timedOut = false;
  // An unanswered permission dialog would otherwise hold the sync open forever.
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, opts.timeoutMs ?? 60_000);
  const out = new Response(proc.stdout as ReadableStream).text();
  void new Response(proc.stderr as ReadableStream).text();
  const code = await proc.exited;
  clearTimeout(timer);
  if (timedOut) throw opts.input === undefined ? new MailProblem("timeout", PIM_COPY.timeout) : new MailProblem("unsure", PIM_UNSURE_COPY);
  let body: unknown;
  try {
    body = JSON.parse(await out);
  } catch {
    throw new MailProblem("other", PIM_COPY.other);
  }
  const err = (body as { error?: { kind?: string } }).error;
  if (code !== 0 || err) {
    const kind = err?.kind ?? "other";
    const copy = kind in PIM_COPY ? PIM_COPY[kind as keyof typeof PIM_COPY] : PIM_COPY.other;
    throw new MailProblem(KINDS[kind] ?? "other", copy);
  }
  return body as T;
}
