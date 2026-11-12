import AppKit
import Carbon
import CoreServices
import EventKit
import Foundation

// atrium-pim: the engine's only window into Mail.app (AppleScript, run here with arguments passed as Apple event
// parameters, never spliced into script text) and Calendar.app (EventKit). One subcommand per call, one JSON
// document on stdout. The interface is pinned in src/engine/mail/pim.ts; tests use tests/fixtures/fake-pim.ts.
// Everything it reads is someone else's text and goes to the engine as plain data.

let mailBundle = "com.apple.mail"
let messageLimitDefault = 500
let snippetChars = 200

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

  on listMessages(acctId, daysBack, maxCount)
    set cutoff to (current date) - (daysBack * days)
    set out to {}
    tell application "Mail"
      set a to first account whose id is acctId
      set boxes to {}
      repeat with b in (every mailbox of a)
        set n to name of b
        if n is in {"INBOX", "Inbox", "Sent", "Sent Messages", "Sent Items", "Sent Mail"} then set end of boxes to b
      end repeat
      repeat with b in boxes
        set msgs to (messages of b whose date sent > cutoff)
        repeat with m in msgs
          if (count of out) ≥ maxCount then exit repeat
          set atts to {}
          repeat with x in mail attachments of m
            try
              set end of atts to {name of x as text, file size of x}
            on error
              set end of atts to {name of x as text, 0}
            end try
          end repeat
          set snip to ""
          try
            set c to content of m
            if length of c > 200 then
              set snip to text 1 thru 200 of c
            else
              set snip to c
            end if
          end try
          set end of out to {id of m as text, name of b as text, all headers of m, subject of m, date sent of m, read status of m, atts, snip}
        end repeat
      end repeat
    end tell
    return out
  end listMessages

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
  let limit = Int(args.flags["limit"] ?? "") ?? messageLimitDefault
  let days = max(1, Int(ceil(Date().timeIntervalSince(since) / 86_400)))
  let list = try runHandler("listMessages", [NSAppleEventDescriptor(string: account), NSAppleEventDescriptor(int32: Int32(days)), NSAppleEventDescriptor(int32: Int32(limit))])
  let messages: [[String: Any]] = items(list).map { m in
    let headers = parseHeaders(m.atIndex(3)?.stringValue ?? "")
    let date = m.atIndex(5)?.dateValue ?? Date(timeIntervalSince1970: 0)
    return [
      "id": encodeMessageId(account: account, mailbox: m.atIndex(2)?.stringValue ?? "", id: m.atIndex(1)?.stringValue ?? ""),
      "messageId": headers["message-id"] as Any,
      "inReplyTo": headers["in-reply-to"] as Any,
      "references": headers["references"] as Any,
      "subject": m.atIndex(4)?.stringValue ?? headers["subject"] ?? "",
      "from": headers["from"] ?? "",
      "to": headers["to"] ?? "",
      "cc": headers["cc"] ?? "",
      "date": iso(date),
      "read": m.atIndex(6)?.booleanValue ?? true,
      "snippet": String((m.atIndex(8)?.stringValue ?? "").prefix(snippetChars)),
      "attachments": m.atIndex(7).map(attachmentsOf) ?? [],
    ]
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
