#!/usr/bin/env bun
// Stands in for /usr/bin/osascript in tests and dev engines: logs its arguments and never scripts any app.
// FAKE_OSASCRIPT_MODE picks how Messages or Contacts "answers"; FAKE_OSASCRIPT_CONTACTS holds the people a lookup
// finds, as a JSON array of [personId, name, kind, label, value] (inline, or a path to a JSON file).
// FAKE_OSASCRIPT_CHATS holds the group chats Messages lists, as [chatId, name, service, [[handle, name], …]] (a null
// name stands for missing value); FAKE_OSASCRIPT_SKIPPED is how many chats the script "couldn't read". A chat send
// answers ATRIUM_NO_CHAT for an id not in that list.
import { appendFileSync, readFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (process.env.FAKE_OSASCRIPT_LOG) appendFileSync(process.env.FAKE_OSASCRIPT_LOG, `${JSON.stringify(argv)}\n`);
const split = argv.indexOf("--");
const script = (split < 0 ? argv : argv.slice(0, split)).filter((_, i) => i % 2 === 1).join("\n");
const send = script.includes('application "Messages"');
const listChats = script.includes("every chat");
const chatSend = script.includes("chat id chatId");
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
const load = (raw: string) => JSON.parse(raw.trim().startsWith("[") ? raw : readFileSync(raw, "utf8"));
const chats = load(process.env.FAKE_OSASCRIPT_CHATS ?? "[]") as [string, string | null, string, [string, string | null][]][];
const field = (v: string | null) => v ?? "missing value";
if (listChats) {
  const C = String.fromCharCode;
  const recs = chats.map(([id, name, svc, ps]) => [id, field(name), svc, ps.map(([h, n]) => `${h}${C(28)}${field(n)}`).join(C(29))].join(C(31)));
  console.log([...recs, `ATRIUM_SKIPPED${C(31)}${process.env.FAKE_OSASCRIPT_SKIPPED ?? "0"}`].join(C(30)));
  process.exit(0);
}
if (chatSend && mode === "chat_error") {
  console.error(`execution error: Messages got an error: Can't get chat id "${argv.at(-2)}". (-1728)`);
  process.exit(1);
}
if (chatSend && !chats.some((c) => c[0] === argv.at(-2))) {
  console.log("ATRIUM_NO_CHAT");
  process.exit(0);
}
if (send) {
  console.log(mode === "no_account" ? "ATRIUM_NO_ACCOUNT" : "ATRIUM_SENT");
  process.exit(0);
}
const people = load(process.env.FAKE_OSASCRIPT_CONTACTS ?? "[]") as string[][];
console.log(people.map((p) => p.join(String.fromCharCode(31))).join(String.fromCharCode(30)));
