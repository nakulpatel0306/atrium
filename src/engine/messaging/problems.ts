import type { OsaResult } from "./osascript";

export type MessagingProblemKind = "automation_denied" | "contacts_denied" | "signed_out" | "no_sms" | "timeout" | "not_installed" | "other";

export class MessagingProblem extends Error {
  constructor(
    readonly kind: MessagingProblemKind,
    message: string,
    // osascript's own words, for the activity log; the card shows only the plain message.
    readonly raw?: string,
  ) {
    super(message);
    this.name = "MessagingProblem";
  }
}

// The one System Settings pane Atrium opens: where Nakul allows it to control Messages and Contacts.
export const SETTINGS_PANES = { automation: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation" } as const;

export const PROBLEM_COPY = {
  automation_denied:
    'Atrium isn\'t allowed to control Messages yet. Open System Settings, go to Privacy & Security › Automation, turn on Messages under "bun" (Atrium\'s engine), then press Send again.',
  contacts_denied:
    'Atrium isn\'t allowed to look in Contacts yet. Open System Settings, go to Privacy & Security › Automation, turn on Contacts under "bun" (Atrium\'s engine), then look again. Or type the number yourself.',
  signed_out: "Messages isn't signed in to iMessage on this Mac. Open Messages, sign in under Settings › iMessage, then press Send again.",
  no_sms: "This Mac can't send SMS. On your iPhone, turn on Text Message Forwarding for this Mac (Settings › Apps › Messages), or send it as iMessage.",
  timeout: {
    Messages:
      "Messages didn't answer within 30 seconds, so Atrium can't tell whether it sent. If macOS is asking for permission, answer that dialog. Check Messages before you press Send again.",
    Contacts: "Contacts didn't answer within 30 seconds. If macOS is asking for permission, answer that dialog, then look again.",
  },
  not_installed: "Atrium couldn't find osascript, which macOS normally includes. Paste the text into Messages yourself for now.",
  other: {
    Messages: "Messages didn't accept that, and Atrium couldn't tell why. Check that Messages is open and signed in, then press Send again.",
    Contacts: "Contacts didn't answer, and Atrium couldn't tell why. Type the number yourself, or look again.",
  },
} as const;

// -1743 is macOS refusing the Apple event: Automation permission for this app is off or was never granted.
export function problemFor(res: OsaResult, app: "Messages" | "Contacts", service?: "iMessage" | "SMS"): MessagingProblem {
  if (res.timedOut) return new MessagingProblem("timeout", PROBLEM_COPY.timeout[app]);
  if (res.code === 127) return new MessagingProblem("not_installed", PROBLEM_COPY.not_installed);
  const raw = (res.err.trim() || res.out.trim()).split("\n")[0]!.slice(0, 200);
  if (/-1743\b|not authori[sz]ed to send apple events/i.test(res.err)) {
    return app === "Contacts"
      ? new MessagingProblem("contacts_denied", PROBLEM_COPY.contacts_denied, raw)
      : new MessagingProblem("automation_denied", PROBLEM_COPY.automation_denied, raw);
  }
  if (res.out.trim() === "ATRIUM_NO_ACCOUNT") {
    return service === "SMS" ? new MessagingProblem("no_sms", PROBLEM_COPY.no_sms) : new MessagingProblem("signed_out", PROBLEM_COPY.signed_out);
  }
  return new MessagingProblem("other", PROBLEM_COPY.other[app], raw);
}
