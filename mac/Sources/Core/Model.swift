import Foundation

// Mirrors `Summary` in src/engine/summary.ts; field names must stay identical.
struct Need: Decodable, Equatable {
  let id, kind, title, spaceName, path: String
  // How many files a review's task made; absent from older engines.
  var files: Int? = nil
  // What a review's agent said when it wasn't plainly done ("couldnt", "partial", "unknown"); absent from older engines.
  var outcome: String? = nil
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
}

struct Note: Equatable {
  let id: String
  let title: String
  let body: String
  let path: String
}
