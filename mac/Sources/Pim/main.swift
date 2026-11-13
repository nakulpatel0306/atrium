import AppKit
import Carbon
import CoreServices
import EventKit
import Foundation

// atrium-pim: the engine's only window into Mail.app (AppleScript, run here with arguments passed as Apple event
// parameters, never spliced into script text) and Calendar.app (EventKit). It reads, opens a filled-in message in
// Mail for the user to send himself, and adds guest-less events; write commands take their JSON on stdin. One subcommand per call, one JSON
// document on stdout. The interface is pinned in src/engine/mail/pim.ts; tests use tests/fixtures/fake-pim.ts.
// Everything it reads is someone else's text and goes to the engine as plain data.

let mailBundle = "com.apple.mail"
// The newest messages kept from each kind of mailbox, counted separately so a busy Inbox never crowds out Sent.
let inboxNames: Set<String> = ["INBOX", "Inbox"]
let sentNames: Set<String> = ["Sent", "Sent Messages", "Sent Items", "Sent Mail"]
let inboxLimit = 300
let sentLimit = 200

// MARK: Mail through AppleScript

let mailScript = """
  on listAccounts()
    set out to {}
    tell application "Mail"
      repeat with a in every account
        set end of out to {id of a as text, name of a as text, email addresses of a, full name of a as text}
      end repeat
    end tell
    return out
  end listAccounts

  on mailboxNames(acctId)
    tell application "Mail"
      return name of every mailbox of (first account whose id is acctId)
    end tell
  end mailboxNames

  -- Ids and sent dates of one mailbox's messages in the window, fetched as two lists in one Apple event each.
  on listIds(acctId, boxName, daysBack)
    set cutoff to (current date) - (daysBack * days)
    tell application "Mail"
      set b to first mailbox of (first account whose id is acctId) whose name is boxName
      return {id, date sent} of (messages of b whose date sent > cutoff)
    end tell
  end listIds

  -- One message's headers and attachment names. Never its content: on IMAP and Exchange that downloads the message.
  on messageHeaders(acctId, boxName, msgId)
    set m to findMessage(acctId, boxName, msgId)
    tell application "Mail"
      set atts to {}
      repeat with x in mail attachments of m
        try
          set end of atts to {name of x as text, file size of x}
        on error
          set end of atts to {name of x as text, 0}
        end try
      end repeat
      return {subject of m, all headers of m, date sent of m, read status of m, atts}
    end tell
  end messageHeaders

  on findMessage(acctId, boxName, msgId)
    tell application "Mail"
      set a to first account whose id is acctId
      set b to first mailbox of a whose name is boxName
      return first message of b whose id is (msgId as integer)
    end tell
  end findMessage

  on getMessage(acctId, boxName, msgId)
    set m to findMessage(acctId, boxName, msgId)
    tell application "Mail"
      set atts to {}
      repeat with x in mail attachments of m
        try
          set end of atts to {name of x as text, file size of x}
        on error
          set end of atts to {name of x as text, 0}
        end try
      end repeat
      return {content of m, atts}
    end tell
  end getMessage

  on saveAttachment(acctId, boxName, msgId, attName, outPath)
    set m to findMessage(acctId, boxName, msgId)
    tell application "Mail"
      set x to first mail attachment of m whose name is attName
      save x in (POSIX file outPath)
    end tell
    return outPath
  end saveAttachment

  -- One message opened in a visible compose window, filled in, and left for the user to send from Mail. With a reply
  -- id it answers that message, so Mail sets In-Reply-To and References; its people and words are then the card's.
  on composeMessage(acctId, fromAddr, toNames, toAddrs, ccNames, ccAddrs, subj, body, replyBox, replyId, attPaths)
    tell application "Mail"
      if replyId is not "" then
        set orig to my findMessage(acctId, replyBox, replyId)
        set m to reply orig opening window true without reply to all
        delete every to recipient of m
        delete every cc recipient of m
        set subject of m to subj
        set content of m to body
      else
        set m to make new outgoing message with properties {subject:subj, content:body, visible:true}
      end if
      set sender of m to fromAddr
      tell m
        repeat with i from 1 to count of toAddrs
          make new to recipient at end of to recipients with properties {name:(item i of toNames), address:(item i of toAddrs)}
        end repeat
        repeat with i from 1 to count of ccAddrs
          make new cc recipient at end of cc recipients with properties {name:(item i of ccNames), address:(item i of ccAddrs)}
        end repeat
        repeat with p in attPaths
          make new attachment with properties {file name:(POSIX file (p as text))} at after the last paragraph
        end repeat
      end tell
      activate
    end tell
    return true
  end composeMessage
  """

func runHandler(_ name: String, _ args: [NSAppleEventDescriptor]) throws -> NSAppleEventDescriptor {
  guard let script = NSAppleScript(source: mailScript) else { throw PimError(kind: "other", message: "The Mail script didn't load.") }
  let params = NSAppleEventDescriptor.list()
  for (i, a) in args.enumerated() { params.insert(a, at: i + 1) }
  let event = NSAppleEventDescriptor(
    eventClass: AEEventClass(kASAppleScriptSuite), eventID: AEEventID(kASSubroutineEvent),
    targetDescriptor: .currentProcess(), returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID))
  event.setParam(NSAppleEventDescriptor(string: name.lowercased()), forKeyword: AEKeyword(keyASSubroutineName))
  event.setParam(params, forKeyword: keyDirectObject)
  var error: NSDictionary?
  let result = script.executeAppleEvent(event, error: &error)
  if let error {
    let code = error[NSAppleScript.errorNumber] as? Int ?? 0
    let message = error[NSAppleScript.errorMessage] as? String ?? "Mail didn't answer."
    if code == -1743 { throw PimError(kind: "automation_denied", message: message) }
    if code == -600 { throw PimError(kind: "not_running", message: message) }
    throw PimError(kind: "other", message: message)
  }
  return result
}

func items(_ d: NSAppleEventDescriptor) -> [NSAppleEventDescriptor] {
  d.numberOfItems == 0 ? [] : (1...d.numberOfItems).compactMap { d.atIndex($0) }
}

func attachmentsOf(_ d: NSAppleEventDescriptor) -> [[String: Any]] {
  items(d).map { a in ["name": a.atIndex(1)?.stringValue ?? "attachment", "size": Int(a.atIndex(2)?.int32Value ?? 0)] }
}

func mailAccounts() throws -> Any {
  let list = try runHandler("listAccounts", [])
  return [
    "accounts": items(list).map { a in
      [
        "id": a.atIndex(1)?.stringValue ?? "",
        "name": a.atIndex(2)?.stringValue ?? "",
        "addresses": a.atIndex(3).map { items($0).compactMap { $0.stringValue } } ?? [],
        "fullName": a.atIndex(4)?.stringValue ?? "",
      ] as [String: Any]
    }
  ]
}

func mailMessages(_ args: PimArgs) throws -> Any {
  guard let account = args.flags["account"], let sinceText = args.flags["since"], let since = isoFormatter.date(from: sinceText) else {
    throw PimError(kind: "bad_args", message: "mail.messages needs --account and --since.")
  }
  let days = max(1, Int(ceil(Date().timeIntervalSince(since) / 86_400)))
  let accountArg = NSAppleEventDescriptor(string: account)
  let boxes = items(try runHandler("mailboxNames", [accountArg])).compactMap { $0.stringValue }
  var messages: [[String: Any]] = []
  for (names, limit) in [(inboxNames, inboxLimit), (sentNames, sentLimit)] {
    // Every matching mailbox's ids and dates, newest first, cut to this kind's limit before any message is read.
    var found: [(box: String, id: String, date: Date)] = []
    for box in boxes where names.contains(box) {
      let pair = try runHandler("listIds", [accountArg, NSAppleEventDescriptor(string: box), NSAppleEventDescriptor(int32: Int32(days))])
      let ids = pair.atIndex(1).map(items) ?? []
      let dates = pair.atIndex(2).map(items) ?? []
      for (i, d) in zip(ids, dates) {
        guard let id = i.stringValue, let date = d.dateValue, date >= since else { continue }
        found.append((box, id, date))
      }
    }
    for f in newestFirst(found, limit: limit) {
      let m = try runHandler("messageHeaders", [account, f.box, f.id].map { NSAppleEventDescriptor(string: $0) })
      let headers = parseHeaders(m.atIndex(2)?.stringValue ?? "")
      messages.append([
        "id": encodeMessageId(account: account, mailbox: f.box, id: f.id),
        "messageId": headers["message-id"] as Any,
        "inReplyTo": headers["in-reply-to"] as Any,
        "references": headers["references"] as Any,
        "subject": m.atIndex(1)?.stringValue ?? headers["subject"] ?? "",
        "from": headers["from"] ?? "",
        "to": headers["to"] ?? "",
        "cc": headers["cc"] ?? "",
        "date": iso(m.atIndex(3)?.dateValue ?? f.date),
        "read": m.atIndex(4)?.booleanValue ?? true,
        "sent": names == sentNames,
        "snippet": "",
        "attachments": m.atIndex(5).map(attachmentsOf) ?? [],
      ])
    }
  }
  return ["messages": messages]
}

func messageRef(_ args: PimArgs) throws -> (account: String, mailbox: String, id: String) {
  guard let raw = args.flags["id"], let ref = decodeMessageId(raw) else { throw PimError(kind: "bad_args", message: "That message id isn't one atrium-pim made.") }
  return ref
}

func mailMessage(_ args: PimArgs) throws -> Any {
  let ref = try messageRef(args)
  let r = try runHandler("getMessage", [ref.account, ref.mailbox, ref.id].map { NSAppleEventDescriptor(string: $0) })
  return ["message": ["text": r.atIndex(1)?.stringValue as Any, "html": NSNull(), "attachments": r.atIndex(2).map(attachmentsOf) ?? []]]
}

func mailAttachment(_ args: PimArgs) throws -> Any {
  let ref = try messageRef(args)
  guard let name = args.flags["name"], let dir = args.flags["out"] else { throw PimError(kind: "bad_args", message: "mail.attachment needs --name and --out.") }
  let path = URL(fileURLWithPath: dir).appendingPathComponent(safeName(name)).path
  _ = try runHandler("saveAttachment", [ref.account, ref.mailbox, ref.id, name, path].map { NSAppleEventDescriptor(string: $0) })
  return ["path": path]
}

// MARK: Writes. Each reads one JSON document on stdin (see pim.ts), so nothing of the message is in argv.

func readInput() throws -> [String: Any] {
  guard let input = parseInput(FileHandle.standardInput.readDataToEndOfFile()) else { throw PimError(kind: "bad_args", message: "This command reads a JSON object on stdin.") }
  return input
}

func stringList(_ values: [String]) -> NSAppleEventDescriptor {
  let list = NSAppleEventDescriptor.list()
  for (i, v) in values.enumerated() { list.insert(NSAppleEventDescriptor(string: v), at: i + 1) }
  return list
}

// Opens the message for the user to send; never sends.
func mailCompose() throws -> Any {
  let input = try readInput()
  guard let account = input["account"] as? String, let from = input["from"] as? String, let subject = input["subject"] as? String, let text = input["text"] as? String else {
    throw PimError(kind: "bad_args", message: "mail.compose needs account, from, subject and text.")
  }
  let to = peopleLists(input["to"])
  let cc = peopleLists(input["cc"])
  if to.addresses.isEmpty { throw PimError(kind: "bad_args", message: "mail.compose needs at least one to address.") }
  var replyBox = ""
  var replyId = ""
  if let raw = input["replyTo"] as? String {
    guard let ref = decodeMessageId(raw), ref.account == account else { throw PimError(kind: "bad_args", message: "That reply id isn't one of this account's messages.") }
    replyBox = ref.mailbox
    replyId = ref.id
  }
  let attachments = (input["attachments"] as? [String]) ?? []
  _ = try runHandler("composeMessage", [
    NSAppleEventDescriptor(string: account), NSAppleEventDescriptor(string: from),
    stringList(to.names), stringList(to.addresses), stringList(cc.names), stringList(cc.addresses),
    NSAppleEventDescriptor(string: subject), NSAppleEventDescriptor(string: text),
    NSAppleEventDescriptor(string: replyBox), NSAppleEventDescriptor(string: replyId),
    stringList(attachments),
  ])
  return ["ok": true]
}

func calCreate() throws -> Any {
  try requireCalendar()
  let input = try readInput()
  let store = eventStore()
  guard let id = input["calendar"] as? String, let cal = store.calendar(withIdentifier: id), let title = input["title"] as? String,
    let start = (input["start"] as? String).flatMap(isoFormatter.date), let end = (input["end"] as? String).flatMap(isoFormatter.date)
  else { throw PimError(kind: "bad_args", message: "cal.create needs calendar, title, start and end.") }
  let e = EKEvent(eventStore: store)
  e.calendar = cal
  e.title = title
  e.startDate = start
  e.endDate = end
  e.isAllDay = (input["allDay"] as? Bool) ?? false
  if let location = input["location"] as? String, !location.isEmpty { e.location = location }
  try store.save(e, span: .thisEvent, commit: true)
  return ["event": ["id": e.eventIdentifier ?? ""]]
}

// Whether Atrium may send Apple events to Mail, asking only when `ask` is set. Mail must be running to be asked.
func mailPermission(ask: Bool) -> String {
  let target = NSAppleEventDescriptor(bundleIdentifier: mailBundle)
  let status = AEDeterminePermissionToAutomateTarget(target.aeDesc, AEEventClass(typeWildCard), AEEventID(typeWildCard), ask)
  switch status {
  case noErr: return "allowed"
  case OSStatus(errAEEventNotPermitted): return "denied"
  case OSStatus(errAEEventWouldRequireUserConsent): return "not_determined"
  case OSStatus(procNotFound): return "not_running"
  default: return "not_determined"
  }
}

// MARK: Calendar through EventKit

// Made only when a calendar command runs, so a mail command never touches EventKit.
var storeCache: EKEventStore?
func eventStore() -> EKEventStore {
  if let s = storeCache { return s }
  let s = EKEventStore()
  storeCache = s
  return s
}

func calendarStatus() -> String {
  switch EKEventStore.authorizationStatus(for: .event) {
  case .fullAccess: return "full"
  case .writeOnly: return "write_only"
  case .denied: return "denied"
  case .restricted: return "restricted"
  default: return "not_determined"
  }
}

func requireCalendar() throws {
  if EKEventStore.authorizationStatus(for: .event) != .fullAccess {
    throw PimError(kind: "calendar_denied", message: "Calendar access isn't allowed.")
  }
}

// EventKit answers on its own queue; the main run loop keeps turning so macOS can show its prompt.
func requestCalendar() -> Bool {
  var done = false
  var granted = false
  eventStore().requestFullAccessToEvents { ok, _ in
    granted = ok
    done = true
  }
  while !done { RunLoop.current.run(until: Date().addingTimeInterval(0.1)) }
  return granted
}

func colorHex(_ c: CGColor?) -> String {
  guard let c, let rgb = c.converted(to: CGColorSpace(name: CGColorSpace.sRGB)!, intent: .defaultIntent, options: nil), let comps = rgb.components, comps.count >= 3 else { return "#8c95a6" }
  return hexColor(Double(comps[0]), Double(comps[1]), Double(comps[2]))
}

func calCalendars() throws -> Any {
  try requireCalendar()
  return [
    "calendars": eventStore().calendars(for: .event).map { c in
      let source = c.source?.title ?? ""
      return [
        "id": c.calendarIdentifier,
        "title": c.title,
        "color": colorHex(c.cgColor),
        "writable": c.allowsContentModifications,
        "source": source,
        "account": source.contains("@") ? source.lowercased() as Any : NSNull(),
      ] as [String: Any]
    }
  ]
}

func status(_ s: EKParticipantStatus) -> Any {
  switch s {
  case .accepted: return "accepted"
  case .declined: return "declined"
  case .tentative: return "tentative"
  case .pending: return "needs_action"
  default: return NSNull()
  }
}

func calEvents(_ args: PimArgs) throws -> Any {
  try requireCalendar()
  guard let id = args.flags["calendar"], let from = args.flags["from"].flatMap(isoFormatter.date), let to = args.flags["to"].flatMap(isoFormatter.date) else {
    throw PimError(kind: "bad_args", message: "cal.events needs --calendar, --from and --to.")
  }
  let store = eventStore()
  guard let cal = store.calendar(withIdentifier: id) else { return ["events": []] }
  let events = store.events(matching: store.predicateForEvents(withStart: from, end: to, calendars: [cal]))
  return [
    "events": events.map { e in
      let repeats = e.hasRecurrenceRules
      let me = e.attendees?.first { $0.isCurrentUser }
      return [
        "id": "\(e.eventIdentifier ?? e.calendarItemIdentifier)|\(iso(e.occurrenceDate ?? e.startDate))",
        "icalUid": e.calendarItemExternalIdentifier ?? e.calendarItemIdentifier,
        "recurrenceId": repeats ? iso(e.occurrenceDate ?? e.startDate) as Any : NSNull(),
        "title": e.title ?? "",
        "start": iso(e.startDate),
        "end": iso(e.endDate),
        "allDay": e.isAllDay,
        "location": e.location ?? "",
        "attendees": (e.attendees ?? []).map { a in ["name": a.name ?? "", "email": mailto(a.url) ?? "", "status": status(a.participantStatus)] as [String: Any] },
        "organizer": mailto(e.organizer?.url) as Any,
        "myStatus": me.map { status($0.participantStatus) } ?? NSNull(),
        "recurrence": repeats ? "repeats" as Any : NSNull(),
      ] as [String: Any]
    }
  ]
}

// MARK: Entry

func run(_ argv: [String]) throws -> Any {
  guard let args = parseArgs(argv) else { throw PimError(kind: "bad_args", message: "Usage: atrium-pim <command> [--flag value]…") }
  switch args.command {
  case "status":
    return ["mail": mailPermission(ask: false), "calendar": calendarStatus()]
  case "allow":
    if args.positional.first == "mail" {
      if NSRunningApplication.runningApplications(withBundleIdentifier: mailBundle).isEmpty { throw PimError(kind: "not_running", message: "Mail isn't open.") }
      if mailPermission(ask: true) != "allowed" { throw PimError(kind: "automation_denied", message: "Mail access wasn't allowed.") }
      return ["ok": true]
    }
    if args.positional.first == "calendar" {
      if !requestCalendar() { throw PimError(kind: "calendar_denied", message: "Calendar access wasn't allowed.") }
      return ["ok": true]
    }
    throw PimError(kind: "bad_args", message: "allow takes mail or calendar.")
  case "mail.accounts": return try mailAccounts()
  case "mail.messages": return try mailMessages(args)
  case "mail.message": return try mailMessage(args)
  case "mail.attachment": return try mailAttachment(args)
  case "cal.calendars": return try calCalendars()
  case "cal.events": return try calEvents(args)
  case "mail.compose": return try mailCompose()
  case "cal.create": return try calCreate()
  default: throw PimError(kind: "bad_args", message: "Unknown command \(args.command).")
  }
}

do {
  print(jsonLine(try run(Array(CommandLine.arguments.dropFirst()))))
  exit(0)
} catch let e as PimError {
  print(errorJSON(e))
  exit(1)
} catch {
  print(errorJSON(PimError(kind: "other", message: String(describing: error))))
  exit(1)
}
