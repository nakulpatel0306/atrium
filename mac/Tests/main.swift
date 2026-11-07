import Foundation

var passed = 0
var failed = 0

func check(_ ok: Bool, _ name: String) {
  if ok {
    passed += 1
  } else {
    failed += 1
    print("FAIL: \(name)")
  }
}

func need(_ id: String, kind: String = "review", title: String = "Fix login") -> Need {
  Need(id: id, kind: kind, title: title, spaceName: "atrium", path: "/space/spc_1?task=\(id)")
}

func summary(needs: [Need] = [], stopped: [Stopped] = [], overnight: Bool = false) -> Summary {
  Summary(needsYou: needs.count, needs: needs, stopped: stopped, overnight: overnight)
}

// badge
check(badgeLabel(0) == nil, "badge: 0 is nil")
check(badgeLabel(3) == "3", "badge: 3")
check(badgeLabel(120) == "99+", "badge: 120 caps")
check(statusTitle(nil) == "", "badge: offline title empty")
check(statusTitle(0) == "", "badge: zero title empty")
check(statusTitle(2) == "2", "badge: title 2")

// decode
let json = """
  {"needsYou":1,"needs":[{"id":"apr_1","kind":"review","title":"Fix login","spaceName":"atrium","path":"/space/spc_1?task=tsk_1"}],"stopped":[{"id":"tsk_2","title":"Ship","spaceName":"atrium","status":"blocked","reason":null,"path":"/space/spc_1?task=tsk_2"}],"overnight":false}
  """
let decoded = try? JSONDecoder().decode(Summary.self, from: Data(json.utf8))
check(decoded != nil, "decode: summary")
check(decoded?.alerts == nil && decoded?.needs.first?.topic == nil, "decode: a summary without topic or alerts still decodes")
check(decoded?.needs.first?.path == "/space/spc_1?task=tsk_1", "decode: need path")
check(decoded != nil && decoded!.stopped.first!.reason == nil, "decode: null reason")

// notes
let s1 = summary(needs: [Need(id: "apr_1", kind: "review", title: "Fix login", spaceName: "atrium", path: "/space/spc_1?task=tsk_1")])
check(newNotes(previous: nil, next: s1).isEmpty, "notes: first summary seeds")
check(
  newNotes(previous: summary(), next: s1)
    == [Note(id: "apr_1", title: "Ready for review", body: "Fix login · atrium", path: "/space/spc_1?task=tsk_1")],
  "notes: new review")
check(newNotes(previous: s1, next: s1).isEmpty, "notes: seen ids don't repeat")
// A need resolved elsewhere and then raised again (same id) is a new event once a summary without it was seen.
let gone = summary()
check(newNotes(previous: s1, next: gone).isEmpty, "notes: a need going away posts nothing")
check(newNotes(previous: gone, next: s1).map(\.id) == ["apr_1"], "notes: a need that comes back after it was gone is new again")
let q = summary(needs: [need("apr_9", kind: "question", title: "Which db?")])
check(newNotes(previous: summary(), next: q).first?.title == "Atrium has a question", "notes: question title")
let sug = summary(needs: [need("prp_1", kind: "suggestion", title: "Stop asking about docs changes?")])
check(
  newNotes(previous: summary(), next: sug)
    == [Note(id: "prp_1", title: "Atrium has a question", body: "Stop asking about docs changes? · atrium", path: "/space/spc_1?task=prp_1")],
  "notes: a new suggestion notifies like a question")
check(newNotes(previous: sug, next: sug).isEmpty, "notes: a seen suggestion doesn't repeat")
let alert = summary(needs: [need("apr_7", kind: "alert", title: "AAPL price above $200.00")])
check(newNotes(previous: summary(), next: alert).first?.title == "Price alert", "notes: price alert title")
let earnings = summary(needs: [Need(id: "apr_e", kind: "alert", title: "RKLB earnings within 5 days", spaceName: "Investing", path: "/space/spc_2", topic: "earnings")])
check(newNotes(previous: summary(), next: earnings).first?.title == "Earnings soon", "notes: earnings title")
let news = summary(needs: [Need(id: "apr_n", kind: "alert", title: "RKLB big news", spaceName: "Investing", path: "/space/spc_2", topic: "news")])
check(newNotes(previous: summary(), next: news).first?.title == "Big news", "notes: news title")
let flag = summary(needs: [Need(id: "apr_f", kind: "alert", title: "Claude flagged NOW", spaceName: "Investing", path: "/space/spc_2", topic: "flag")])
check(newNotes(previous: summary(), next: flag).first?.title == "Flagged by Claude", "notes: flag title")
let indicator = summary(needs: [Need(id: "apr_i", kind: "alert", title: "AAPL RSI(14) below 30", spaceName: "Investing", path: "/space/spc_2", topic: "indicator")])
check(newNotes(previous: summary(), next: indicator).first?.title == "Price alert", "notes: indicator alert reads as a price alert")
let withAlerts = try? JSONDecoder().decode(
  Summary.self,
  from: Data(#"{"needsYou":1,"needs":[{"id":"a","kind":"alert","title":"t","spaceName":"s","path":"/","topic":"news"}],"stopped":[],"overnight":false,"alerts":{"price":0,"earnings":0,"news":1,"flag":0}}"#.utf8))
check(withAlerts?.needs.first?.topic == "news", "decode: need topic")
check(withAlerts?.alerts == AlertCounts(price: 0, earnings: 0, news: 1, flag: 0), "decode: alert counts")
let blocked = Stopped(id: "tsk_2", title: "Ship", spaceName: "atrium", status: "blocked", reason: "Claude is signed out", path: "/space/spc_1?task=tsk_2")
let blockedNotes = newNotes(previous: summary(), next: summary(stopped: [blocked]))
check(blockedNotes.first?.title == "Blocked" && blockedNotes.first?.body == "Ship · Claude is signed out", "notes: blocked uses reason")
let failedTask = Stopped(id: "tsk_3", title: "Build", spaceName: "atrium", status: "failed", reason: nil, path: "/space/spc_1?task=tsk_3")
let failedNotes = newNotes(previous: summary(), next: summary(stopped: [failedTask]))
check(failedNotes.first?.title == "Didn't finish" && failedNotes.first?.body == "Build · atrium", "notes: failed falls back to space")
check(newNotes(previous: summary(stopped: [failedTask]), next: summary(stopped: [failedTask])).isEmpty, "notes: seen stopped don't repeat")
let four = summary(needs: (1...4).map { need("apr_\($0)") })
let collapsed = newNotes(previous: summary(), next: four)
check(collapsed.count == 1 && collapsed[0].title == "4 things need you" && collapsed[0].path == "/", "notes: more than three collapse")
check(collapsed.first?.id == "batch-apr_1", "notes: batch id")
check(newNotes(previous: summary(), next: summary(needs: (1...3).map { need("apr_\($0)") })).count == 3, "notes: three stay separate")

// menu
let seven = summary(needs: (1...7).map { need("apr_\($0)") })
let menu = menuNeeds(seven)
check(menu.shown.count == 5 && menu.more == 2, "menu: first five and more")
let long = needTitle(need("apr_1", title: String(repeating: "a", count: 80)))
check(long.count == 60 && long.hasSuffix("…"), "menu: long title cut to 60")
check(needTitle(need("apr_1")) == "Fix login · atrium", "menu: short title")

// port
check(resolvePort(env: ["ATRIUM_PORT": "7431"], defaultsPort: 7440) == 7431, "port: env wins")
check(resolvePort(env: [:], defaultsPort: 7440) == 7440, "port: defaults")
check(resolvePort(env: [:], defaultsPort: 0) == 7420, "port: fallback")
check(resolvePort(env: ["ATRIUM_PORT": "nope"], defaultsPort: 0) == 7420, "port: bad env ignored")

// start
if case .manual = startAction(port: 7431, plistExists: true, loaded: true, cliKnown: true) {
  check(true, "start: dev port is manual")
} else {
  check(false, "start: dev port is manual")
}
check(startAction(port: 7420, plistExists: true, loaded: true, cliKnown: true) == .kickstart, "start: kickstart")
check(startAction(port: 7420, plistExists: true, loaded: false, cliKnown: false) == .bootstrap, "start: bootstrap")
check(startAction(port: 7420, plistExists: false, loaded: false, cliKnown: true) == .install, "start: install")
if case .manual = startAction(port: 7420, plistExists: false, loaded: false, cliKnown: false) {
  check(true, "start: nothing known is manual")
} else {
  check(false, "start: nothing known is manual")
}

// links
check(isInternal(URL(string: "http://127.0.0.1:7420/space/x")!, port: 7420), "links: 127.0.0.1 internal")
check(isInternal(URL(string: "http://localhost:7420/")!, port: 7420), "links: localhost internal")
check(isInternal(URL(string: "about:blank")!, port: 7420), "links: about:blank internal")
check(!isInternal(URL(string: "http://127.0.0.1:7431/")!, port: 7420), "links: other port external")
check(!isInternal(URL(string: "https://github.com/x")!, port: 7420), "links: github external")
check(!isInternal(URL(string: "mailto:a@b.c")!, port: 7420), "links: mailto external")

// link policy: only user clicks in the main frame leave the app, and only to web or mail
let ext = URL(string: "https://github.com/x/pull/1")!
check(linkDecision(URL(string: "http://127.0.0.1:7420/space/x")!, port: 7420, userClick: false, mainFrame: true) == .allow, "policy: internal loads")
check(linkDecision(URL(string: "http://127.0.0.1:7420/")!, port: 7420, userClick: false, mainFrame: false) == .allow, "policy: internal subframe loads")
check(linkDecision(ext, port: 7420, userClick: true, mainFrame: true) == .openExternally, "policy: http link click opens browser")
check(linkDecision(URL(string: "mailto:a@b.c")!, port: 7420, userClick: true, mainFrame: true) == .openExternally, "policy: mailto click")
check(linkDecision(ext, port: 7420, userClick: false, mainFrame: true) == .cancel, "policy: script-initiated http cancelled")
check(linkDecision(ext, port: 7420, userClick: true, mainFrame: false) == .cancel, "policy: subframe http cancelled")
check(linkDecision(URL(string: "file:///etc/passwd")!, port: 7420, userClick: true, mainFrame: true) == .cancel, "policy: file cancelled")
check(linkDecision(URL(string: "javascript:alert(1)")!, port: 7420, userClick: true, mainFrame: true) == .cancel, "policy: javascript cancelled")
check(linkDecision(URL(string: "x-apple.systempreferences:foo")!, port: 7420, userClick: true, mainFrame: true) == .cancel, "policy: x-apple cancelled")
check(linkDecision(URL(string: "slack://open")!, port: 7420, userClick: true, mainFrame: true) == .cancel, "policy: custom scheme cancelled")
check(linkDecision(URL(string: "http://127.0.0.1:7431/")!, port: 7420, userClick: true, mainFrame: true) == .openExternally, "policy: other local port is external")

// offline: only a failure to reach the engine swaps in the offline view
check(isOfflineLoadError(domain: NSURLErrorDomain, code: NSURLErrorCannotConnectToHost), "offline: can't connect")
check(isOfflineLoadError(domain: NSURLErrorDomain, code: NSURLErrorNetworkConnectionLost), "offline: connection lost")
check(isOfflineLoadError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut), "offline: timed out")
check(!isOfflineLoadError(domain: NSURLErrorDomain, code: NSURLErrorCancelled), "offline: cancelled load is not offline")
check(!isOfflineLoadError(domain: "WebKitErrorDomain", code: 102), "offline: policy interruption is not offline")

// user input: script a.click() also reports linkActivated, so only a real recent click or key counts
check(isRecentUserInput(.leftMouseUp, age: 0.2), "input: recent click")
check(isRecentUserInput(.keyDown, age: 0.5), "input: recent key (Return on a link)")
check(isRecentUserInput(.otherMouseUp, age: 0.1), "input: middle click")
check(!isRecentUserInput(nil, age: 0), "input: no event")
check(!isRecentUserInput(.leftMouseUp, age: 3), "input: stale click")
check(!isRecentUserInput(.other, age: 0.1), "input: mouse move or other event")
check(
  linkDecision(ext, port: 7420, userClick: isRecentUserInput(nil, age: 0), mainFrame: true) == .cancel,
  "policy: linkActivated with no input event is cancelled")

// files made
check(madeText(nil) == nil && madeText(0) == nil, "made: nothing to say")
check(madeText(1) == "made 1 file", "made: one")
check(madeText(4) == "made 4 files", "made: many")
let withFiles = summary(needs: [Need(id: "apr_m", kind: "review", title: "Make a grocery list", spaceName: "Weekly Planning", path: "/space/spc_1?task=tsk_m", files: 4)])
check(
  newNotes(previous: summary(), next: withFiles)
    == [Note(id: "apr_m", title: "Ready for review", body: "Make a grocery list · Weekly Planning · made 4 files", path: "/space/spc_1?task=tsk_m")],
  "notes: a review says how many files it made")
let oneFile = summary(needs: [Need(id: "apr_o", kind: "review", title: "Notes", spaceName: "Weekly Planning", path: "/space/spc_1?task=tsk_o", files: 1)])
check(newNotes(previous: summary(), next: oneFile).first?.body == "Notes · Weekly Planning · made 1 file", "notes: one file")
let filesJson = """
  {"needsYou":1,"needs":[{"id":"apr_1","kind":"review","title":"Fix login","spaceName":"atrium","path":"/p","topic":null,"files":4}],"stopped":[],"overnight":false}
  """
check((try? JSONDecoder().decode(Summary.self, from: Data(filesJson.utf8)))?.needs.first?.files == 4, "decode: files")

// symbols in alert titles
check(alertTitle("price", "AMZN") == "AMZN price alert", "alert: price with symbol")
check(alertTitle("indicator", "AMZN") == "AMZN price alert", "alert: indicator with symbol")
check(alertTitle(nil, "AMZN") == "AMZN price alert", "alert: no topic with symbol")
check(alertTitle("earnings", "NOW") == "NOW earnings soon", "alert: earnings with symbol")
check(alertTitle("news", "RKLB") == "Big news on RKLB", "alert: news with symbol")
check(alertTitle("flag", "TSLA") == "Claude flagged TSLA", "alert: flag with symbol")
check(alertTitle("price", nil) == "Price alert", "alert: price without symbol")
check(alertTitle("earnings", nil) == "Earnings soon", "alert: earnings without symbol")
let symJson = """
  {"needsYou":1,"needs":[{"id":"apr_s","kind":"alert","title":"AMZN price above $300.00","spaceName":"Investing","path":"/p","topic":"price","files":0,"symbol":"AMZN"}],"stopped":[],"overnight":false,"embed":{"port":7421,"token":"abc"}}
  """
let symDecoded = try? JSONDecoder().decode(Summary.self, from: Data(symJson.utf8))
check(symDecoded?.needs.first?.symbol == "AMZN", "decode: need symbol")
check(symDecoded?.embed == Embed(port: 7421, token: "abc"), "decode: embed listener")
check(decoded?.needs.first?.symbol == nil && decoded?.embed == nil, "decode: older summaries without symbol or embed")
let alertNeed = Need(id: "apr_s", kind: "alert", title: "AMZN price above $300.00", spaceName: "Investing", path: "/p", topic: "price", files: 0, symbol: "AMZN")
check(newNotes(previous: summary(), next: summary(needs: [alertNeed])).first?.title == "AMZN price alert", "notes: alert names its symbol")

// TradingView frames: only as subframes, only TradingView's widget hosts or the engine's chart listener
let tvFrame = URL(string: "https://www.tradingview-widget.com/embed-widget/advanced-chart/")!
check(isTvFrame(tvFrame), "tv: widget host")
check(isTvFrame(URL(string: "https://s.tradingview.com/embed-widget/x/")!), "tv: fallback host")
check(!isTvFrame(URL(string: "http://www.tradingview-widget.com/")!), "tv: http refused")
check(!isTvFrame(URL(string: "https://www.tradingview.com/chart/")!), "tv: main site is not a frame host")
check(linkDecision(tvFrame, port: 7420, userClick: false, mainFrame: false) == .allow, "policy: TradingView subframe without a click")
check(linkDecision(tvFrame, port: 7420, userClick: false, mainFrame: true) == .cancel, "policy: TradingView as main frame without a click")
check(linkDecision(URL(string: "https://www.tradingview.com/chart/")!, port: 7420, userClick: false, mainFrame: false) == .cancel, "policy: tradingview.com subframe")
check(linkDecision(URL(string: "https://evil.example/")!, port: 7420, userClick: false, mainFrame: false) == .cancel, "policy: other subframe")
let chartPage = URL(string: "http://localhost:7421/embed/abc/tradingview?symbol=NASDAQ:AMZN")!
check(linkDecision(chartPage, port: 7420, userClick: false, mainFrame: false, embedPort: 7421) == .allow, "policy: the engine's chart listener as subframe")
check(linkDecision(chartPage, port: 7420, userClick: false, mainFrame: false) == .cancel, "policy: no reported listener, no chart frame")
check(linkDecision(chartPage, port: 7420, userClick: false, mainFrame: false, embedPort: 7422) == .cancel, "policy: a different port isn't the chart listener")
check(linkDecision(chartPage, port: 7420, userClick: false, mainFrame: true, embedPort: 7421) == .cancel, "policy: the chart listener never as main frame")
check(linkDecision(URL(string: "http://localhost:7420/embed/tradingview")!, port: 7420, userClick: false, mainFrame: false) == .allow, "policy: own port subframe still internal")

// content rules: block everything, then allow the engine, its chart listener and TradingView
let rules = contentRulesJSON(port: 7420, embedPort: 7421)
let parsed = (try? JSONSerialization.jsonObject(with: Data(rules.utf8))) as? [[String: Any]]
check(parsed != nil, "rules: valid JSON")
let firstRule = parsed?.first
check(((firstRule?["trigger"] as? [String: Any])?["url-filter"] as? String) == ".*", "rules: first rule matches everything")
check(((firstRule?["action"] as? [String: Any])?["type"] as? String) == "block", "rules: first rule blocks")
let filters = (parsed ?? []).compactMap { ($0["trigger"] as? [String: Any])?["url-filter"] as? String }
check(rules.contains("127\\\\.0\\\\.0\\\\.1:7420"), "rules: engine port")
check(rules.contains("localhost:7421"), "rules: chart listener port")
check(rules.contains("tradingview-widget"), "rules: widget host")
check(!filters.contains { $0.contains("|") }, "rules: no alternation")
check(!rules.contains("\\\\.?"), "rules: no optional dots")
check(!rules.contains("googleapis"), "rules: no Google")
check(!contentRulesJSON(port: 7420, embedPort: nil).contains("7421"), "rules: no listener, no listener rule")

// popups: only the dashboard itself opens a page in the app; a frame's popup goes to the browser on a click, or nowhere
check(popupDecision(URL(string: "about:blank")!, port: 7420, userClick: false, fromDashboard: false) == .cancel, "popup: about:blank from a frame never replaces the dashboard")
check(popupDecision(URL(string: "http://127.0.0.1:7420/api/state")!, port: 7420, userClick: false, fromDashboard: false) == .cancel, "popup: engine URL from a frame never loads in the main view")
check(popupDecision(URL(string: "http://127.0.0.1:7420/api/state")!, port: 7420, userClick: true, fromDashboard: false) == .cancel, "popup: engine URL from a frame isn't opened in the browser either")
check(popupDecision(URL(string: "https://www.tradingview.com/symbols/NASDAQ-AMZN/")!, port: 7420, userClick: true, fromDashboard: false) == .openExternally, "popup: TradingView attribution opens in the browser")
check(popupDecision(URL(string: "https://www.tradingview.com/symbols/NASDAQ-AMZN/")!, port: 7420, userClick: false, fromDashboard: false) == .cancel, "popup: a frame's popup without a click is dropped")
check(popupDecision(URL(string: "mailto:a@b.c")!, port: 7420, userClick: true, fromDashboard: false) == .cancel, "popup: a frame can't open mail")
check(popupDecision(URL(string: "http://127.0.0.1:7420/space/x")!, port: 7420, userClick: true, fromDashboard: true) == .allow, "popup: the dashboard's own target=_blank stays in the app")
check(popupDecision(URL(string: "https://github.com/x/pull/1")!, port: 7420, userClick: true, fromDashboard: true) == .openExternally, "popup: the dashboard's external link opens the browser")
check(popupDecision(URL(string: "https://github.com/x/pull/1")!, port: 7420, userClick: false, fromDashboard: true) == .cancel, "popup: the dashboard's script popup without a click is dropped")
check(popupDecision(URL(string: "file:///etc/passwd")!, port: 7420, userClick: true, fromDashboard: true) == .cancel, "popup: file is dropped")
check(isDashboardOrigin(scheme: "http", host: "127.0.0.1", port: 7420, enginePort: 7420), "popup: dashboard origin")
check(!isDashboardOrigin(scheme: "http", host: "localhost", port: 7421, enginePort: 7420), "popup: chart listener isn't the dashboard")
check(!isDashboardOrigin(scheme: "https", host: "www.tradingview-widget.com", port: 0, enginePort: 7420), "popup: TradingView isn't the dashboard")

// backoff
check(nextBackoff(0) == 2, "backoff: floor")
check(nextBackoff(2) == 4, "backoff: doubles")
check(nextBackoff(16) == 30, "backoff: caps")
check(nextBackoff(30) == 30, "backoff: stays capped")

// outcomes and texts
let textNeed = Need(id: "apr_t", kind: "question", title: "Send a text to Dana?", spaceName: "Messages", path: "/", action: "send_message")
check(newNotes(previous: summary(), next: summary(needs: [textNeed])).first?.title == "Text ready to send", "notes: a text waiting to send")
let couldntNeed = Need(id: "apr_c", kind: "review", title: "Summarise notes.md", spaceName: "Notes", path: "/space/spc_3", outcome: "couldnt")
check(newNotes(previous: summary(), next: summary(needs: [couldntNeed])).first?.title == "Couldn't do this", "notes: couldn't")
let partialNeed = Need(id: "apr_p", kind: "review", title: "Write three files", spaceName: "Notes", path: "/space/spc_3", outcome: "partial")
check(newNotes(previous: summary(), next: summary(needs: [partialNeed])).first?.title == "Partly done", "notes: partly done")
let unknownNeed = Need(id: "apr_u", kind: "review", title: "Answer", spaceName: "Notes", path: "/space/spc_3", outcome: "unknown")
check(newNotes(previous: summary(), next: summary(needs: [unknownNeed])).first?.title == "Ready for review", "notes: unknown reads as a review")
let newJson = #"{"needsYou":1,"needs":[{"id":"a","kind":"review","title":"t","spaceName":"s","path":"/","topic":null,"files":0,"symbol":null,"outcome":"couldnt","action":null}],"stopped":[],"overnight":false}"#
check((try? JSONDecoder().decode(Summary.self, from: Data(newJson.utf8)))?.needs.first?.outcome == "couldnt", "decode: outcome")
check(decoded?.needs.first?.outcome == nil && decoded?.needs.first?.action == nil, "decode: an older engine has no outcome or action")

// money nudges
let budget = Nudge(id: "mnd_1", kind: "budget", title: "Dining reached its October budget", body: "CA$420.00 of CA$400.00 in October.", path: "/space/spc_9?tab=money")
var withNudge = summary()
withNudge.nudges = [budget]
let nudgeNotes = newNotes(previous: summary(), next: withNudge)
check(nudgeNotes == [Note(id: "mnd_1", title: "Dining reached its October budget", body: "CA$420.00 of CA$400.00 in October.", path: "/space/spc_9?tab=money")], "notes: a money nudge is notified with its own title")
check(newNotes(previous: withNudge, next: withNudge).isEmpty, "notes: a seen nudge doesn't repeat")
check(withNudge.needsYou == 0, "notes: nudges don't add to the badge")
let nudgeJson = #"{"needsYou":0,"needs":[],"stopped":[],"overnight":false,"nudges":[{"id":"mnd_2","kind":"import","title":"Time to import October","body":"Amex isn't imported for October yet.","path":"/space/spc_9?tab=money","spaceId":"spc_9","spaceName":"Investing","createdAt":1}]}"#
check((try? JSONDecoder().decode(Summary.self, from: Data(nudgeJson.utf8)))?.nudges?.first?.kind == "import", "decode: nudges")

let fresh = Nudge(id: "mnd_3", kind: "import", title: "Time to import October", body: "Amex isn't imported for October yet.", path: "/", createdAt: 1_000_000_000_000)
var launch = summary()
launch.nudges = [fresh, budget]
let atLaunch = newNotes(previous: nil, next: launch, now: Date(timeIntervalSince1970: 1_000_000_000 + 3600))
check(atLaunch.map(\.id) == ["mnd_3"], "notes: a reminder made in the last day is announced at launch; budget nudges aren't")
check(newNotes(previous: nil, next: launch, now: Date(timeIntervalSince1970: 1_000_000_000 + 2 * 86400)).isEmpty, "notes: an older reminder only seeds")

print("\(passed) passed, \(failed) failed")
exit(failed == 0 ? 0 : 1)

