import Foundation

// The parts of atrium-pim that don't touch Mail or Calendar, so they can be tested on any Mac: argument parsing,
// header parsing, opaque message ids and JSON output.

struct PimArgs {
  let command: String
  let positional: [String]
  let flags: [String: String]
}

// "mail.messages --account X --since Y" → command and flags. A flag with no value is an error, not a guess.
func parseArgs(_ argv: [String]) -> PimArgs? {
  guard let command = argv.first else { return nil }
  var positional: [String] = []
  var flags: [String: String] = [:]
  var i = 1
  while i < argv.count {
    let a = argv[i]
    if a.hasPrefix("--") {
      guard i + 1 < argv.count else { return nil }
      flags[String(a.dropFirst(2))] = argv[i + 1]
      i += 2
    } else {
      positional.append(a)
      i += 1
    }
  }
  return PimArgs(command: command, positional: positional, flags: flags)
}

// Raw header block → lowercased name to unfolded value; the first of a repeated header wins.
func parseHeaders(_ raw: String) -> [String: String] {
  var out: [String: String] = [:]
  var name: String?
  var value = ""
  func flush() {
    if let n = name, out[n] == nil { out[n] = value.trimmingCharacters(in: .whitespaces) }
  }
  for line in raw.replacingOccurrences(of: "\r\n", with: "\n").split(separator: "\n", omittingEmptySubsequences: false) {
    if line.isEmpty { break }
    if line.first == " " || line.first == "\t" {
      value += " " + line.trimmingCharacters(in: .whitespaces)
      continue
    }
    flush()
    guard let colon = line.firstIndex(of: ":") else {
      name = nil
      continue
    }
    name = line[..<colon].lowercased()
    value = String(line[line.index(after: colon)...])
  }
  flush()
  return out
}

// Mail.app needs account, mailbox and message id to find a message again; the engine gets them as one opaque id.
func encodeMessageId(account: String, mailbox: String, id: String) -> String {
  let data = try! JSONSerialization.data(withJSONObject: [account, mailbox, id])
  return data.base64EncodedString()
}

func decodeMessageId(_ s: String) -> (account: String, mailbox: String, id: String)? {
  guard let data = Data(base64Encoded: s),
    let parts = try? JSONSerialization.jsonObject(with: data) as? [String], parts.count == 3
  else { return nil }
  return (parts[0], parts[1], parts[2])
}

// An attachment name from a message can't name a folder, climb out of the one it's saved into, or hide its real
// extension behind bidi or other invisible format characters.
func safeName(_ name: String) -> String {
  let last = name.replacingOccurrences(of: "\\", with: "/").split(separator: "/").last.map(String.init) ?? ""
  let cleaned = String(
    last.unicodeScalars.filter { $0.value >= 0x20 && !(0x7f...0x9f).contains($0.value) && $0 != ":" && $0.properties.generalCategory != .format }
  ).trimmingCharacters(in: CharacterSet(charactersIn: ". "))
  return cleaned.isEmpty ? "attachment" : String(cleaned.prefix(120))
}

let isoFormatter: ISO8601DateFormatter = {
  let f = ISO8601DateFormatter()
  f.formatOptions = [.withInternetDateTime]
  return f
}()

func iso(_ d: Date) -> String { isoFormatter.string(from: d) }

func jsonLine(_ value: Any) -> String {
  guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return "{}" }
  return String(decoding: data, as: UTF8.self)
}

struct PimError: Error {
  let kind: String
  let message: String
}

func errorJSON(_ e: PimError) -> String { jsonLine(["error": ["kind": e.kind, "message": e.message]]) }

// "#rrggbb" from 0…1 components.
func hexColor(_ r: Double, _ g: Double, _ b: Double) -> String {
  let c = { (v: Double) in max(0, min(255, Int((v * 255).rounded()))) }
  return String(format: "#%02x%02x%02x", c(r), c(g), c(b))
}

// The address in "mailto:sam@example.com", or nil.
func mailto(_ url: URL?) -> String? {
  guard let s = url?.absoluteString, s.lowercased().hasPrefix("mailto:") else { return nil }
  return String(s.dropFirst(7)).removingPercentEncoding?.lowercased()
}

// The newest `limit` of a mailbox's messages, by sent date; ties keep their listed order.
func newestFirst<T>(_ found: [(box: String, id: String, date: T)], limit: Int) -> [(box: String, id: String, date: T)] where T: Comparable {
  Array(found.enumerated().sorted { $0.element.date != $1.element.date ? $0.element.date > $1.element.date : $0.offset < $1.offset }.map(\.element).prefix(limit))
}

// A write command's JSON document from stdin, as an object, or nil.
func parseInput(_ data: Data) -> [String: Any]? {
  (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
}

// [{"name", "address"}] → parallel name and address lists for AppleScript. An entry without an address is dropped, and
// line breaks in names are removed so they read as one line.
func peopleLists(_ value: Any?) -> (names: [String], addresses: [String]) {
  var names: [String] = []
  var addresses: [String] = []
  for p in (value as? [[String: Any]]) ?? [] {
    guard let a = p["address"] as? String, !a.isEmpty else { continue }
    names.append(((p["name"] as? String) ?? "").replacingOccurrences(of: "\n", with: " ").replacingOccurrences(of: "\r", with: " "))
    addresses.append(a)
  }
  return (names, addresses)
}
