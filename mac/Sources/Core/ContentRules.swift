import Foundation

// WebKit content rules for the app's web view: block every load, then let through the engine on its port, and
// data:, blob: and about:. WebKit's content-blocker regex has no `|`, so each allowed origin is a rule of its own.
func contentRulesJSON(port: Int) -> String {
  let allowed = [
    "^https?://127\\.0\\.0\\.1:\(port)[/?#]",
    "^https?://localhost:\(port)[/?#]",
    "^wss?://127\\.0\\.0\\.1:\(port)/",
    "^wss?://localhost:\(port)/",
    "^data:",
    "^blob:",
    "^about:",
  ]
  let rules: [[String: Any]] =
    [["trigger": ["url-filter": ".*"], "action": ["type": "block"]]]
    + allowed.map { ["trigger": ["url-filter": $0], "action": ["type": "ignore-previous-rules"]] }
  guard let data = try? JSONSerialization.data(withJSONObject: rules, options: [.withoutEscapingSlashes]) else { return "[]" }
  return String(decoding: data, as: UTF8.self)
}
