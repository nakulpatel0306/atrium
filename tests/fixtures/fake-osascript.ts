#!/usr/bin/env bun
// Stands in for /usr/bin/osascript in tests and dev engines: logs its arguments and never scripts any app.
// FAKE_OSASCRIPT_MODE picks how Messages or Contacts "answers"; FAKE_OSASCRIPT_CONTACTS holds the people a lookup
// finds, as a JSON array of [personId, name, kind, label, value] (inline, or a path to a JSON file).
import { appendFileSync, readFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (process.env.FAKE_OSASCRIPT_LOG) appendFileSync(process.env.FAKE_OSASCRIPT_LOG, `${JSON.stringify(argv)}\n`);
const split = argv.indexOf("--");
const script = (split < 0 ? argv : argv.slice(0, split)).filter((_, i) => i % 2 === 1).join("\n");
const send = script.includes('application "Messages"');
const app = send ? "Messages" : "Contacts";
const mode = process.env.FAKE_OSASCRIPT_MODE ?? "ok";

if (mode === "hang") await Bun.sleep(120_000);
if (mode === "denied") {
  console.error(`execution error: Not authorized to send Apple events to ${app}. (-1743)`);
  process.exit(1);
}
if (mode === "fail") {
  console.error("execution error: boom (-1708)");
  process.exit(1);
}
if (send) {
  console.log(mode === "no_account" ? "ATRIUM_NO_ACCOUNT" : "ATRIUM_SENT");
  process.exit(0);
}
const raw = process.env.FAKE_OSASCRIPT_CONTACTS ?? "[]";
const people = JSON.parse(raw.trim().startsWith("[") ? raw : readFileSync(raw, "utf8")) as string[][];
console.log(people.map((p) => p.join(String.fromCharCode(31))).join(String.fromCharCode(30)));
