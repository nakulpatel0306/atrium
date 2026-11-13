import Foundation

let enginePort = 7420
let maxBackoff: TimeInterval = 30
let minBackoff: TimeInterval = 2

func badgeLabel(_ count: Int) -> String? {
  if count <= 0 { return nil }
  return count > 99 ? "99+" : String(count)
}

func statusTitle(_ count: Int?) -> String {
  guard let count else { return "" }
  return badgeLabel(count) ?? ""
}

func needTitle(_ n: Need) -> String {
  let full = "\(n.title) · \(n.spaceName)"
  return full.count > 60 ? String(full.prefix(59)) + "…" : full
}

func menuNeeds(_ s: Summary) -> (shown: [Need], more: Int) {
  (Array(s.needs.prefix(5)), max(0, s.needs.count - 5))
}

// "made 4 files" for a review's notification; nothing when the task made none.
func madeText(_ n: Int?) -> String? {
  guard let n, n > 0 else { return nil }
  return n == 1 ? "made 1 file" : "made \(n) files"
}

// Notes only for ids the previous summary didn't have, so a reconnect or wake never repeats what Nakul already saw.
// The first summary after launch only seeds: the badge already shows what was waiting.
// A result the agent didn't finish says so in the title, before anything else.
func noteTitle(_ n: Need) -> String {
  if n.kind == "review" && n.outcome == "couldnt" { return "Couldn't do this" }
  if n.kind == "review" && n.outcome == "partial" { return "Partly done" }
  if n.kind == "review" { return "Ready for review" }
  return "Atrium has a question"
}

func newNotes(previous: Summary?, next: Summary) -> [Note] {
  guard let previous else { return [] }
  let seenNeeds = Set(previous.needs.map(\.id))
  let seenStopped = Set(previous.stopped.map(\.id))
  var notes: [Note] = next.needs.filter { !seenNeeds.contains($0.id) }.map {
    Note(
      // A suggestion ("stop asking about this?") waits on an answer, like a question.
      id: $0.id, title: noteTitle($0),
      body: [$0.title, $0.spaceName, $0.kind == "review" ? madeText($0.files) : nil].compactMap { $0 }.joined(separator: " · "), path: $0.path)
  }
  notes += next.stopped.filter { !seenStopped.contains($0.id) }.map {
    Note(
      id: $0.id, title: $0.status == "blocked" ? "Blocked" : "Didn't finish",
      body: "\($0.title) · \($0.reason ?? $0.spaceName)", path: $0.path)
  }
  if notes.count > 3 {
    return [Note(id: "batch-\(notes[0].id)", title: "\(notes.count) things need you", body: "Open Atrium to see them.", path: "/")]
  }
  return notes
}

func resolvePort(env: [String: String], defaultsPort: Int) -> Int {
  if let raw = env["ATRIUM_PORT"], let port = Int(raw), port > 0 { return port }
  return defaultsPort > 0 ? defaultsPort : enginePort
}

enum StartAction: Equatable {
  case kickstart, bootstrap, install, manual(String)
}

// Any port but 7420 is a dev engine, and starting the installed one would be the wrong engine.
func startAction(port: Int, plistExists: Bool, loaded: Bool, cliKnown: Bool) -> StartAction {
  if port != enginePort {
    return .manual("This window points at a dev engine on port \(port). Start that engine yourself.")
  }
  if plistExists && loaded { return .kickstart }
  if plistExists { return .bootstrap }
  if cliKnown { return .install }
  return .manual("Run atrium install in a terminal, then try again.")
}

func isInternal(_ url: URL, port: Int) -> Bool {
  if url.absoluteString == "about:blank" { return true }
  guard url.scheme == "http", let host = url.host else { return false }
  return (host == "127.0.0.1" || host == "localhost") && url.port == port
}

enum InputKind {
  case leftMouseDown, leftMouseUp, otherMouseUp, keyDown, other
}

// WebKit marks a script's a.click() as linkActivated too, so a click only counts when a real mouse or key event
// arrived within the last second.
func isRecentUserInput(_ kind: InputKind?, age: TimeInterval) -> Bool {
  guard let kind, kind != .other else { return false }
  return age >= 0 && age <= 1
}

enum LinkDecision: Equatable {
  case allow, openExternally, cancel
}

// Dashboard pages show agent-written text, so a link or script there must not get NSWorkspace to open files or
// launch other apps. Only a click Nakul made in the main frame leaves the app, and only to the web or mail.
func linkDecision(_ url: URL, port: Int, userClick: Bool, mainFrame: Bool) -> LinkDecision {
  if isInternal(url, port: port) { return .allow }
  let scheme = url.scheme?.lowercased() ?? ""
  guard ["http", "https", "mailto"].contains(scheme), userClick, mainFrame else { return .cancel }
  return .openExternally
}

// A popup (window.open, target=_blank) loads in the app only when the dashboard itself opened it and it's one of
// the dashboard's own pages. One from a frame goes to the default browser on a real click, for http(s) off the
// engine, or nowhere: a frame must never replace the dashboard or open the engine's API.
func popupDecision(_ url: URL, port: Int, userClick: Bool, fromDashboard: Bool) -> LinkDecision {
  if fromDashboard { return linkDecision(url, port: port, userClick: userClick, mainFrame: true) }
  let scheme = url.scheme?.lowercased() ?? ""
  let loopback = url.host == "127.0.0.1" || url.host == "localhost"
  guard userClick, ["http", "https"].contains(scheme), !loopback else { return .cancel }
  return .openExternally
}

// What the file picker offers: CSVs for imports, and the kinds of file the ask bar attaches (the dashboard's
// ALLOWED_EXT in src/engine/attachment-rules.ts; a test keeps the two lists the same). WebKit doesn't pass the
// input's accept list on, so this is the union, and the dashboard checks each file again.
let pickerExtensions = ["png", "jpg", "jpeg", "heic", "gif", "webp", "pdf", "txt", "md", "csv", "json", "xlsx", "docx"]

func isDashboardOrigin(scheme: String, host: String, port: Int, enginePort: Int) -> Bool {
  scheme == "http" && (host == "127.0.0.1" || host == "localhost") && port == enginePort
}

// WebKit also reports cancelled loads (a reload over a reload, a policy cancel) as failures; only a load that
// couldn't reach the engine means it's offline.
func isOfflineLoadError(domain: String, code: Int) -> Bool {
  guard domain == NSURLErrorDomain else { return false }
  return [
    NSURLErrorCannotConnectToHost, NSURLErrorNetworkConnectionLost, NSURLErrorTimedOut, NSURLErrorCannotFindHost,
    NSURLErrorNotConnectedToInternet,
  ].contains(code)
}

func nextBackoff(_ current: TimeInterval) -> TimeInterval {
  max(minBackoff, min(current * 2, maxBackoff))
}
