import AppKit
import UniformTypeIdentifiers
import WebKit

@MainActor
final class WebController: NSObject, WKNavigationDelegate, WKUIDelegate {
  let webView: WKWebView
  let port: Int
  var onLoadFailed: (() -> Void)?
  // The engine's chart listener port, from its summary; nil until reported or when the listener didn't start.
  private(set) var embedPort: Int?
  private var rulesReady = false
  private var pendingLoad = false

  init(port: Int) {
    self.port = port
    let configuration = WKWebViewConfiguration()
    // Scripts (the dashboard's or TradingView's) can't open windows without a click.
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
    webView = WKWebView(frame: .zero, configuration: configuration)
    super.init()
    webView.navigationDelegate = self
    webView.uiDelegate = self
    // No white flash before the dashboard paints.
    webView.setValue(false, forKey: "drawsBackground")
    webView.underPageBackgroundColor = .atriumBackground
    compileRules { [weak self] in
      guard let self else { return }
      self.rulesReady = true
      if self.pendingLoad { self.load() }
    }
  }

  // Every load is confined by a content rule list; the page waits for it. A compile error is logged and the page
  // still loads, since the dashboard's own CSP applies either way.
  private func compileRules(_ done: @escaping @MainActor () -> Void) {
    let json = contentRulesJSON(port: port, embedPort: embedPort)
    WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "atrium-\(port)", encodedContentRuleList: json) { [weak self] list, error in
      Task { @MainActor in
        guard let self else { return }
        if let error { NSLog("Atrium: content rules didn't compile: \(error.localizedDescription)") }
        let content = self.webView.configuration.userContentController
        content.removeAllContentRuleLists()
        if let list { content.add(list) }
        done()
      }
    }
  }

  // The chart listener's port comes from the engine; a new one recompiles the rules so its frame may load.
  func setEmbedPort(_ next: Int?) {
    guard next != embedPort else { return }
    embedPort = next
    compileRules {}
  }

  func load() {
    guard rulesReady else {
      pendingLoad = true
      return
    }
    pendingLoad = false
    webView.load(URLRequest(url: URL(string: "http://127.0.0.1:\(port)/")!))
  }

  // The dashboard's router listens for popstate, so this moves to the path without reloading the page.
  func navigate(path: String) {
    guard let data = try? JSONSerialization.data(withJSONObject: path, options: .fragmentsAllowed),
      let quoted = String(data: data, encoding: .utf8)
    else { return }
    webView.evaluateJavaScript("history.pushState(null,\"\",\(quoted));dispatchEvent(new PopStateEvent(\"popstate\"))")
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    let e = error as NSError
    if isOfflineLoadError(domain: e.domain, code: e.code) { onLoadFailed?() }
  }

  // A crashed or killed WebContent process leaves a blank window; reloading brings the dashboard back.
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    webView.reload()
  }

  private func decide(_ action: WKNavigationAction) -> LinkDecision {
    guard let url = action.request.url else { return .cancel }
    let userClick = action.navigationType == .linkActivated && recentUserInput()
    return linkDecision(url, port: port, userClick: userClick, mainFrame: action.targetFrame?.isMainFrame ?? true, embedPort: embedPort)
  }

  private func recentUserInput() -> Bool {
    guard let e = NSApp.currentEvent else { return isRecentUserInput(nil, age: 0) }
    let kind: InputKind =
      switch e.type {
      case .leftMouseDown: .leftMouseDown
      case .leftMouseUp: .leftMouseUp
      case .otherMouseUp: .otherMouseUp
      case .keyDown: .keyDown
      default: .other
      }
    return isRecentUserInput(kind, age: ProcessInfo.processInfo.systemUptime - e.timestamp)
  }

  func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
    switch decide(navigationAction) {
    case .allow: return .allow
    case .openExternally:
      NSWorkspace.shared.open(navigationAction.request.url!)
      return .cancel
    case .cancel: return .cancel
    }
  }

  // target=_blank: off-site links (PRs, docs in agent output) go to the default browser, the dashboard's own pages
  // stay in this window, and the app never opens a second web view.
  func webView(
    _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction,
    windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    guard let url = navigationAction.request.url else { return nil }
    let source = navigationAction.sourceFrame
    let origin = source.securityOrigin
    let fromDashboard = source.isMainFrame && isDashboardOrigin(scheme: origin.protocol, host: origin.host, port: origin.port, enginePort: port)
    let userClick = navigationAction.navigationType == .linkActivated && recentUserInput()
    switch popupDecision(url, port: port, userClick: userClick, fromDashboard: fromDashboard) {
    case .allow: webView.load(navigationAction.request)
    case .openExternally: NSWorkspace.shared.open(url)
    case .cancel: break
    }
    return nil
  }

  // <input type="file"> does nothing in a WKWebView without this. Only the dashboard's own page may open the picker
  // (the chart frame never can), and it only offers CSVs, the one kind of file the dashboard imports.
  func webView(
    _ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo,
    completionHandler: @escaping ([URL]?) -> Void
  ) {
    let origin = frame.securityOrigin
    guard frame.isMainFrame, isDashboardOrigin(scheme: origin.protocol, host: origin.host, port: origin.port, enginePort: port) else {
      completionHandler(nil)
      return
    }
    let panel = NSOpenPanel()
    panel.canChooseFiles = true
    panel.canChooseDirectories = false
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection
    panel.allowedContentTypes = [.commaSeparatedText]
    guard let window = webView.window else {
      completionHandler(panel.runModal() == .OK ? panel.urls : nil)
      return
    }
    panel.beginSheetModal(for: window) { response in
      completionHandler(response == .OK ? panel.urls : nil)
    }
  }
}
