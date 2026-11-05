import Foundation

// Mirrors `Summary` in src/engine/summary.ts; field names must stay identical.
struct Need: Decodable, Equatable {
  let id, kind, title, spaceName, path: String
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
