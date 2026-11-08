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

// Only "no such chat" (-1728, -1719) means the chat is gone. Anything else (Automation denied, Messages quitting, a
// timeout) is raised again, so it gets its own wording and the picked chat is kept. Prints ATRIUM_NO_CHAT.
export const CHAT_GONE_CATCH: readonly string[] = [
  "on error errMsg number errNum",
  'if errNum is -1728 or errNum is -1719 then return "ATRIUM_NO_CHAT"',
  "error errMsg number errNum",
  "end try",
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
  ...CHAT_GONE_CATCH,
  'if not (enabled of acct) then return "ATRIUM_NO_ACCOUNT"',
  "send body to target",
  "end tell",
  'return "ATRIUM_SENT"',
  "end run",
];

// Builds `bad`: every control character, including the separators 28–31 the chat list uses.
export const BAD_CHARS: readonly string[] = [
  "set bad to {}",
  "repeat with i from 1 to 31",
  "set end of bad to character id i",
  "end repeat",
  "set end of bad to character id 127",
];

// `my clean(t, bad)`: t without any character in bad, so a name can never carry a separator and forge a record.
export const CLEAN_HANDLER: readonly string[] = [
  "on clean(t, bad)",
  "set AppleScript's text item delimiters to bad",
  "set parts to text items of t",
  'set AppleScript\'s text item delimiters to ""',
  "return parts as text",
  "end clean",
];

// No argv. Prints one record per group chat: its id, name, service and members, never a message. Records are split by
// character id 30, fields by 31: chat id, chat name, service, members. Members are split by 29, and each member's
// handle and Contacts name ("full name", Nakul's own card for them) by 28. Every value is cleaned of control
// characters first.
// Only group chats are opened: their ids carry ";+;" (one-person chats carry ";-;"), so one bulk read of every id is
// all a one-person chat costs. An id with neither marker is opened and kept only with more than one member. Each chat
// is read in its own try, so one unreadable chat costs one row, counted in a last record ATRIUM_SKIPPED, n.
export const CHATS_SCRIPT: readonly string[] = [
  "on run argv",
  "set rs to character id 30",
  "set us to character id 31",
  "set gs to character id 29",
  "set fs to character id 28",
  ...BAD_CHARS,
  "set recs to {}",
  "set skipped to 0",
  'tell application "Messages"',
  "set allIds to id of every chat",
  "repeat with k in allIds",
  "set chatKey to (contents of k) as text",
  'if chatKey does not contain ";-;" then',
  "try",
  "set c to chat id chatKey",
  "set hs to handle of every participant of c",
  'if chatKey contains ";+;" or (count of hs) > 1 then',
  "set ns to full name of every participant of c",
  "set cname to my clean((name of c) as text, bad)",
  'set svc to "SMS"',
  "try",
  "set svc to (service type of (account of c)) as text",
  "end try",
  "set members to {}",
  "repeat with j from 1 to (count of hs)",
  "set end of members to my clean((item j of hs) as text, bad) & fs & my clean((item j of ns) as text, bad)",
  "end repeat",
  "set AppleScript's text item delimiters to gs",
  "set mt to members as text",
  'set AppleScript\'s text item delimiters to ""',
  "set end of recs to my clean(chatKey, bad) & us & cname & us & my clean(svc, bad) & us & mt",
  "end if",
  "on error",
  "set skipped to skipped + 1",
  "end try",
  "end if",
  "end repeat",
  "end tell",
  'set end of recs to "ATRIUM_SKIPPED" & us & (skipped as text)',
  "set AppleScript's text item delimiters to rs",
  "set res to recs as text",
  'set AppleScript\'s text item delimiters to ""',
  "return res",
  "end run",
  ...CLEAN_HANDLER,
];
