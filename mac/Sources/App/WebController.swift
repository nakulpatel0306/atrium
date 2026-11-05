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

  func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
    guard let url = navigationAction.request.url, !isInternal(url, port: port) else { return .allow }
    NSWorkspace.shared.open(url)
    return .cancel
  }

  // target=_blank links (PRs, docs in agent output) belong in the default browser.
  func webView(
    _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction,
    windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
    return nil
  }
}
