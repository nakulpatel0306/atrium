// The only AppleScript Atrium ever runs, as fixed text. Everything that varies (the service, the recipient, the
// message, a contact's name) arrives as `argv` after "--", so nothing a person or an agent types is ever read as
// script. One array item per line; osascript gets each as its own -e.

// argv: service ("iMessage" | "SMS"), handle, text. Prints ATRIUM_SENT once Messages has accepted the send, or
// ATRIUM_NO_ACCOUNT when no enabled account of that service exists.
export const SEND_SCRIPT: readonly string[] = [
  "on run argv",
  "set svc to item 1 of argv",
  "set target to item 2 of argv",
  "set body to item 3 of argv",
  'tell application "Messages"',
  'if svc is "SMS" then',
  "set accts to (every account whose service type is SMS and enabled is true)",
  "else",
  "set accts to (every account whose service type is iMessage and enabled is true)",
  "end if",
  'if (count of accts) is 0 then return "ATRIUM_NO_ACCOUNT"',
  "send body to participant target of (item 1 of accts)",
  "end tell",
  'return "ATRIUM_SENT"',
  "end run",
];

// argv: query. Prints one record per phone number and email of up to 20 people whose name contains the query.
// Records are split by character id 30 and fields by character id 31: personId, name, "phone"|"email", label, value.
export const LOOKUP_SCRIPT: readonly string[] = [
  "on run argv",
  "set q to item 1 of argv",
  "set rs to character id 30",
  "set us to character id 31",
  "set recs to {}",
  'tell application "Contacts"',
  "set found to (every person whose name contains q)",
  "set n to 0",
  "repeat with p in found",
  "set n to n + 1",
  "if n > 20 then exit repeat",
  "set pid to (id of p) as text",
  "set pname to (name of p) as text",
  "repeat with ph in (phones of p)",
  'set end of recs to pid & us & pname & us & "phone" & us & ((label of ph) as text) & us & ((value of ph) as text)',
  "end repeat",
  "repeat with em in (emails of p)",
  'set end of recs to pid & us & pname & us & "email" & us & ((label of em) as text) & us & ((value of em) as text)',
  "end repeat",
  "end repeat",
  "end tell",
  "set AppleScript's text item delimiters to rs",
  "set res to recs as text",
  'set AppleScript\'s text item delimiters to ""',
  "return res",
  "end run",
];
