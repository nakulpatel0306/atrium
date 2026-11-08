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

// argv: chat id, text. Sends to an existing chat, never makes one. Prints ATRIUM_SENT once Messages has accepted the
// send, ATRIUM_NO_CHAT when no chat has that id, or ATRIUM_NO_ACCOUNT when the chat's account is off.
export const SEND_CHAT_SCRIPT: readonly string[] = [
  "on run argv",
  "set chatId to item 1 of argv",
  "set body to item 2 of argv",
  'tell application "Messages"',
  "try",
  "set target to chat id chatId",
  "set acct to account of target",
  "on error",
  'return "ATRIUM_NO_CHAT"',
  "end try",
  'if not (enabled of acct) then return "ATRIUM_NO_ACCOUNT"',
  "send body to target",
  "end tell",
  'return "ATRIUM_SENT"',
  "end run",
];

// No argv. Prints one record per group chat (more than one other person): never a message, only who's in it.
// Records are split by character id 30, fields by 31: chat id, chat name, service, members. Members are split by 29,
// and each member's handle and name by 28.
export const CHATS_SCRIPT: readonly string[] = [
  "on run argv",
  "set rs to character id 30",
  "set us to character id 31",
  "set gs to character id 29",
  "set fs to character id 28",
  "set recs to {}",
  'tell application "Messages"',
  "repeat with c in (every chat)",
  "set ps to participants of c",
  "if (count of ps) > 1 then",
  "set members to {}",
  "repeat with p in ps",
  "set end of members to ((handle of p) as text) & fs & ((name of p) as text)",
  "end repeat",
  "set AppleScript's text item delimiters to gs",
  "set mt to members as text",
  'set AppleScript\'s text item delimiters to ""',
  "set end of recs to ((id of c) as text) & us & ((name of c) as text) & us & ((service type of (account of c)) as text) & us & mt",
  "end if",
  "end repeat",
  "end tell",
  "set AppleScript's text item delimiters to rs",
  "set res to recs as text",
  'set AppleScript\'s text item delimiters to ""',
  "return res",
  "end run",
];
