import Foundation

// Mirrors `Summary` in src/engine/summary.ts; field names must stay identical.
struct Need: Decodable, Equatable {
  let id, kind, title, spaceName, path: String
  // The kind of market alert ("price", "indicator", "earnings", "news", "flag"); absent from older engines.
  var topic: String? = nil
}

struct AlertCounts: Decodable, Equatable {
  let price, earnings, news, flag: Int
}

struct Stopped: Decodable, Equatable {
  let id, title, spaceName, status: String
  let reason: String?
  let path: String
}

struct Summary: Decodable, Equatable {
  let needsYou: Int
  let needs: [Need]
  let stopped: [Stopped]
  let overnight: Bool
  var alerts: AlertCounts? = nil
}

struct Note: Equatable {
  let id: String
  let title: String
  let body: String
  let path: String
}
