#!/usr/bin/env bun
// Stands in for atrium-pim (mac/Sources/Pim) in tests and dev engines: answers from a JSON file and never touches
// Mail, Calendar or any permission. FAKE_PIM_DATA is the file's path:
//   {"accounts": [...], "messages": {"<account id>": [...]}, "bodies": {"<message id>": {...}},
//    "calendars": [...], "events": {"<calendar id>": [...]}}
// in the shapes src/engine/mail/pim.ts documents. FAKE_PIM_MODE: "ok" (default), "mail_denied", "calendar_denied",
// "hang", "malformed" (answers {} to everything). FAKE_PIM_LOG, if set, gets each call's argv as a JSON line.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
if (process.env.FAKE_PIM_LOG) appendFileSync(process.env.FAKE_PIM_LOG, `${JSON.stringify(argv)}\n`);
const mode = process.env.FAKE_PIM_MODE ?? "ok";
const data = process.env.FAKE_PIM_DATA && existsSync(process.env.FAKE_PIM_DATA) ? JSON.parse(readFileSync(process.env.FAKE_PIM_DATA, "utf8")) : {};
const flag = (f: string) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const out = (v: unknown) => {
  console.log(JSON.stringify(v));
  process.exit(0);
};
const fail = (kind: string, message: string) => {
  console.log(JSON.stringify({ error: { kind, message } }));
  process.exit(1);
};

if (mode === "hang") await Bun.sleep(300_000);
// An older or broken helper: valid JSON without the list it should have.
if (mode === "malformed") out({});
const cmd = argv[0] ?? "";
const mailCmd = cmd.startsWith("mail.") || (cmd === "allow" && argv[1] === "mail");
const calCmd = cmd.startsWith("cal.") || (cmd === "allow" && argv[1] === "calendar");
if (mode === "mail_denied" && mailCmd) fail("automation_denied", "Not authorized to send Apple events to Mail. (-1743)");
if (mode === "calendar_denied" && calCmd) fail("calendar_denied", "Calendar access denied.");

switch (cmd) {
  case "status":
    out({ mail: mode === "mail_denied" ? "denied" : "allowed", calendar: mode === "calendar_denied" ? "denied" : "full" });
    break;
  case "allow":
    out({ ok: true });
    break;
  case "mail.accounts":
    out({ accounts: data.accounts ?? [] });

    break;
  case "mail.messages": {
    const since = Date.parse(flag("--since") ?? "1970-01-01");
    // Like the helper: headers only (no snippet), newest first, Inbox and Sent capped separately. A message whose
    // "mailbox" is "Sent" counts toward Sent; anything else is Inbox.
    const msgs = (data.messages?.[flag("--account") ?? ""] ?? []) as { date: string; mailbox?: string }[];
    const recent = msgs.filter((m) => Date.parse(m.date) >= since).sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
    const sent = recent.filter((m) => m.mailbox === "Sent").slice(0, Number(process.env.FAKE_PIM_SENT_LIMIT ?? 200));
    const inbox = recent.filter((m) => m.mailbox !== "Sent").slice(0, Number(process.env.FAKE_PIM_INBOX_LIMIT ?? 300));
    out({ messages: [...inbox, ...sent].map(({ mailbox: _, ...m }) => ({ ...m, snippet: "" })) });
    break;
  }
  case "mail.message": {
    const b = data.bodies?.[flag("--id") ?? ""];
    if (!b) fail("other", "No such message.");
    out({ message: b });
    break;
  }
  case "mail.attachment": {
    const path = join(flag("--out")!, flag("--name")!);
    writeFileSync(path, "fake attachment");
    out({ path });
    break;
  }
  case "cal.calendars":
    out({ calendars: data.calendars ?? [] });
    break;
  case "cal.events":
    out({ events: data.events?.[flag("--calendar") ?? ""] ?? [] });
    break;
  default:
    fail("bad_args", `Unknown command ${cmd}`);
}
