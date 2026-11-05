import AppKit
import WebKit

@MainActor
final class WebController: NSObject, WKNavigationDelegate, WKUIDelegate {
  let webView: WKWebView
  let port: Int

  init(port: Int) {
    self.port = port
    webView = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
    super.init()
    webView.navigationDelegate = self
    webView.uiDelegate = self
    // No white flash before the dashboard paints.
    webView.setValue(false, forKey: "drawsBackground")
    webView.underPageBackgroundColor = .atriumBackground
  }

  func load() {
    webView.load(URLRequest(url: URL(string: "http://127.0.0.1:\(port)/")!))
  }

  // The dashboard's router listens for popstate, so this moves to the path without reloading the page.
  func navigate(path: String) {
    guard let data = try? JSONSerialization.data(withJSONObject: path, options: .fragmentsAllowed),
      let quoted = String(data: data, encoding: .utf8)
    else { return }
    webView.evaluateJavaScript("history.pushState(null,\"\",\(quoted));dispatchEvent(new PopStateEvent(\"popstate\"))")
  }

  private func decide(_ action: WKNavigationAction) -> LinkDecision {
    guard let url = action.request.url else { return .cancel }
    return linkDecision(
      url, port: port, userClick: action.navigationType == .linkActivated, mainFrame: action.targetFrame?.isMainFrame ?? true)
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
    switch decide(navigationAction) {
    case .allow: webView.load(navigationAction.request)
    case .openExternally: NSWorkspace.shared.open(navigationAction.request.url!)
    case .cancel: break
    }
    return nil
  }
}
