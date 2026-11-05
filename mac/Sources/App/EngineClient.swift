import AppKit
import Foundation

struct EngineError: LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

// Badge, menu and notifications all come from here. Reads happen only when the socket opens, on a `changed` event,
// or on wake; the one timer is the reconnect backoff while the engine is unreachable.
@MainActor
final class EngineClient {
  let port: Int
  var onSummary: ((Summary) -> Void)?
  var onOnline: ((Bool) -> Void)?
  private(set) var latest: Summary?

  private let session = URLSession(configuration: .ephemeral)
  private var socket: URLSessionWebSocketTask?
  // Callbacks from a socket that was since replaced must not fail or refresh the current one.
  private var generation = 0
  private var backoff: TimeInterval = 0
  private var retry: Timer?
  private var fetching = false
  private var refetch = false
  private var origin: String { "http://127.0.0.1:\(port)" }

  init(port: Int) {
    self.port = port
    NSWorkspace.shared.notificationCenter.addObserver(
      forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated { self?.reconnectNow() }
    }
  }

  func start() {
    connect()
  }

  func reconnectNow() {
    backoff = 0
    connect()
  }

  func post(_ path: String, _ body: [String: Any]) async throws {
    var req = URLRequest(url: URL(string: origin + path)!)
    req.httpMethod = "POST"
    req.setValue(origin, forHTTPHeaderField: "Origin")
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = try JSONSerialization.data(withJSONObject: body)
    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await session.data(for: req)
    } catch {
      throw EngineError(message: "Couldn't reach the Atrium engine. Check that it's running, then try again.")
    }
    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      let text = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
      throw EngineError(message: text ?? "The engine couldn't do that. Check the engine log.")
    }
  }

  private func connect() {
    retry?.invalidate()
    retry = nil
    socket?.cancel(with: .goingAway, reason: nil)
    generation += 1
    let gen = generation
    var req = URLRequest(url: URL(string: "ws://127.0.0.1:\(port)/ws?events=changed")!)
    req.setValue(origin, forHTTPHeaderField: "Origin")
    let task = session.webSocketTask(with: req)
    socket = task
    task.resume()
    // A pong is the first sign the upgrade went through; the engine may not send anything for hours.
    task.sendPing { [weak self] error in
      Task { @MainActor in self?.opened(gen, error) }
    }
    receive(task, gen)
  }

  private func opened(_ gen: Int, _ error: Error?) {
    guard gen == generation else { return }
    if error != nil { return failed(gen) }
    backoff = 0
    onOnline?(true)
    refresh()
  }

  private func receive(_ task: URLSessionWebSocketTask, _ gen: Int) {
    task.receive { [weak self] result in
      Task { @MainActor in
        guard let self, gen == self.generation else { return }
        switch result {
        case .success:
          self.refresh()
          self.receive(task, gen)
        case .failure:
          self.failed(gen)
        }
      }
    }
  }

  private func failed(_ gen: Int) {
    guard gen == generation, retry == nil else { return }
    socket?.cancel()
    socket = nil
    onOnline?(false)
    backoff = nextBackoff(backoff)
    retry = Timer.scheduledTimer(withTimeInterval: backoff, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated { self?.connect() }
    }
  }

  // One fetch in flight and at most one queued behind it, so a burst of changes costs two requests.
  private func refresh() {
    if fetching {
      refetch = true
      return
    }
    fetching = true
    Task {
      if let s = await fetchSummary() {
        latest = s
        onSummary?(s)
      }
      fetching = false
      if refetch {
        refetch = false
        refresh()
      }
    }
  }

  private func fetchSummary() async -> Summary? {
    guard let (data, response) = try? await session.data(from: URL(string: origin + "/api/summary")!),
      (response as? HTTPURLResponse)?.statusCode == 200
    else { return nil }
    return try? JSONDecoder().decode(Summary.self, from: data)
  }
}
