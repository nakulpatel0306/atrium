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
//     → {"ok": true}  Asks macOS for the permission (the prompt the dashboard announced first).
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
//   Reserved for Phase B (draft and send), same conventions: mail.send, mail.draft, cal.create, cal.rsvp.
//
// Failure: a non-zero exit and {"error": {"kind": "automation_denied"|"calendar_denied"|"not_running"|"bad_args"|"other", "message": string}}.

export const PIM_COPY = {
  not_installed: "Atrium's Mail and Calendar helper isn't installed. Run atrium app install in Terminal, then try again.",
  automation_denied:
    'Atrium isn\'t allowed to read Mail yet. Open System Settings, go to Privacy & Security › Automation, turn on Mail under "bun" (Atrium\'s engine), then press Sync.',
  calendar_denied: "Atrium isn't allowed to read your calendars yet. Open System Settings, go to Privacy & Security › Calendars, turn on Atrium, then press Sync.",
  timeout: "Mail or Calendar didn't answer within a minute. If macOS is asking for permission, answer that dialog, then press Sync.",
  not_running: "Mail isn't open, so Atrium couldn't read it. Open Mail, then press Sync.",
  other: "Mail or Calendar didn't answer, and Atrium couldn't tell why. Check that both open normally, then press Sync.",
} as const;

const KINDS: Record<string, MailProblemKind> = { automation_denied: "automation_denied", calendar_denied: "calendar_denied", not_running: "other" };

export async function runPim<T>(args: string[], opts: { timeoutMs?: number } = {}): Promise<T> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([config().pimBin, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env } });
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
  if (timedOut) throw new MailProblem("timeout", PIM_COPY.timeout);
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
