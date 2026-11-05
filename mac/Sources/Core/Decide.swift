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

// Notes only for ids the previous summary didn't have, so a reconnect or wake never repeats what Nakul already saw.
// The first summary after launch only seeds: the badge already shows what was waiting.
func newNotes(previous: Summary?, next: Summary) -> [Note] {
  guard let previous else { return [] }
  let seenNeeds = Set(previous.needs.map(\.id))
  let seenStopped = Set(previous.stopped.map(\.id))
  var notes: [Note] = next.needs.filter { !seenNeeds.contains($0.id) }.map {
    Note(
      id: $0.id, title: $0.kind == "question" ? "Atrium has a question" : "Ready for review",
      body: "\($0.title) · \($0.spaceName)", path: $0.path)
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
