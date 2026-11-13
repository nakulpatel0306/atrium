import Foundation

// Mirrors `Summary` in src/engine/summary.ts; field names must stay identical.
struct Need: Decodable, Equatable {
  let id, kind, title, spaceName, path: String
  // The kind of market alert ("price", "indicator", "earnings", "news", "flag"); absent from older engines.
  var topic: String? = nil
  // How many files a review's task made; absent from older engines.
  var files: Int? = nil
  // The instrument an alert is about ("AMZN"); absent from older engines and for everything but alerts.
  var symbol: String? = nil
  // What a review's agent said when it wasn't plainly done ("couldnt", "partial", "unknown"); absent from older engines.
  var outcome: String? = nil
}

// The engine's TradingView chart listener this launch; absent from older engines, null when it didn't start.
struct Embed: Decodable, Equatable {
  let port: Int
  let token: String
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
  var embed: Embed? = nil
}

struct Note: Equatable {
  let id: String
  let title: String
  let body: String
  let path: String
}
