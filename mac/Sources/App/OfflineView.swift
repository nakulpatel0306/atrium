import AppKit

// Shown in place of the dashboard while the engine can't be reached. The engine owns the data, so this only says
// nothing is lost and offers the one engine action the app takes: starting it.
@MainActor
final class OfflineView: NSView {
  private let port: Int
  private let onStarted: () -> Void
  private let button = NSButton(title: "Start it", target: nil, action: nil)
  private let manual = OfflineView.label("", size: 13, color: .atriumMuted)
  private let error = OfflineView.label("", size: 13, color: NSColor(srgbRed: 0xeb / 255, green: 0x57 / 255, blue: 0x57 / 255, alpha: 1))

  init(port: Int, onStarted: @escaping () -> Void) {
    self.port = port
    self.onStarted = onStarted
    super.init(frame: .zero)
    wantsLayer = true
    layer?.backgroundColor = NSColor.atriumBackground.cgColor

    let logo = NSImageView()
    if let url = Bundle.main.url(forResource: "logo-mark", withExtension: "svg"), let image = NSImage(contentsOf: url) {
      image.isTemplate = true
      image.size = NSSize(width: 40, height: 40)
      logo.image = image
    }
    logo.contentTintColor = .atriumMuted
    logo.widthAnchor.constraint(equalToConstant: 40).isActive = true
    logo.heightAnchor.constraint(equalToConstant: 40).isActive = true

    let title = OfflineView.label("Atrium engine isn't running", size: 15, color: .atriumText, weight: .semibold)
    let detail = OfflineView.label("Nothing is lost. Your spaces and tasks are waiting for it.", size: 13, color: .atriumMuted)
    button.bezelStyle = .rounded
    button.keyEquivalent = "\r"
    button.target = self
    button.action = #selector(start)
    error.isHidden = true
    manual.isHidden = true
    // With everything installed, only a dev port makes the start manual; say so before Nakul presses anything.
    if case .manual(let message) = startAction(port: port, plistExists: true, loaded: true, cliKnown: true) {
      showManual(message)
    }

    let stack = NSStackView(views: [logo, title, detail, button, manual, error])
    stack.orientation = .vertical
    stack.alignment = .centerX
    stack.spacing = 10
    stack.setCustomSpacing(16, after: logo)
    stack.setCustomSpacing(18, after: detail)
    stack.translatesAutoresizingMaskIntoConstraints = false
    addSubview(stack)
    NSLayoutConstraint.activate([
      stack.centerXAnchor.constraint(equalTo: centerXAnchor),
      stack.centerYAnchor.constraint(equalTo: centerYAnchor),
      stack.widthAnchor.constraint(lessThanOrEqualToConstant: 460),
    ])
  }

  required init?(coder: NSCoder) { fatalError("not used") }

  private static func label(_ text: String, size: CGFloat, color: NSColor, weight: NSFont.Weight = .regular) -> NSTextField {
    let l = NSTextField(wrappingLabelWithString: text)
    l.font = .systemFont(ofSize: size, weight: weight)
    l.textColor = color
    l.alignment = .center
    l.isSelectable = false
    return l
  }

  private func showManual(_ message: String) {
    button.isHidden = true
    manual.stringValue = message
    manual.isHidden = false
  }

  @objc private func start() {
    button.isEnabled = false
    button.title = "Starting…"
    error.isHidden = true
    let port = self.port
    Task {
      let result = await Starter.start(port: port)
      button.isEnabled = true
      button.title = "Start it"
      switch result {
      case .started: onStarted()
      case .manual(let message): showManual(message)
      case .failed(let message):
        error.stringValue = message
        error.isHidden = false
      }
    }
  }
}

extension NSColor {
  static var atriumText: NSColor { NSColor(srgbRed: 0xe6 / 255, green: 0xe6 / 255, blue: 0xea / 255, alpha: 1) }
  static var atriumMuted: NSColor { NSColor(srgbRed: 0x8a / 255, green: 0x8a / 255, blue: 0x94 / 255, alpha: 1) }
}

// Runs off the main thread: launchctl and `atrium install` can take a few seconds.
enum Starter {
  enum Result: Sendable { case started, manual(String), failed(String) }

  static let label = "com.atrium.engine"

  static func start(port: Int) async -> Result {
    let info = Bundle.main.infoDictionary ?? [:]
    let bun = info["AtriumBunPath"] as? String
    let repo = info["AtriumRepoPath"] as? String
    return await Task.detached { () -> Result in
      let fm = FileManager.default
      let domain = "gui/\(getuid())"
      let plist = fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents/\(label).plist").path
      let cliKnown = bun.map(fm.fileExists) == true && repo.map(fm.fileExists) == true
      // Only ask launchd about the job when the port could be the installed engine's.
      let loaded = port == enginePort && run("/bin/launchctl", ["print", "\(domain)/\(label)"]).code == 0
      switch startAction(port: port, plistExists: fm.fileExists(atPath: plist), loaded: loaded, cliKnown: cliKnown) {
      case .manual(let message): return .manual(message)
      case .kickstart: return outcome(run("/bin/launchctl", ["kickstart", "\(domain)/\(label)"]))
      case .bootstrap: return outcome(run("/bin/launchctl", ["bootstrap", domain, plist]))
      case .install: return outcome(run(bun!, ["\(repo!)/src/cli.ts", "install"], path: installPath(bun: bun!)))
      }
    }.value
  }

  // Apps launched from Finder get a bare PATH, and `atrium install` looks up bun and claude on it.
  private static func installPath(bun: String) -> String {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    let dirs = [(bun as NSString).deletingLastPathComponent, "\(home)/.local/bin", "\(home)/.bun/bin", "/opt/homebrew/bin", "/usr/local/bin"]
    return (dirs + [ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"]).joined(separator: ":")
  }

  private static func outcome(_ r: (code: Int32, text: String)) -> Result {
    r.code == 0 ? .started : .failed(r.text.isEmpty ? "Couldn't start the engine. Check the engine log." : r.text)
  }

  private static func run(_ tool: String, _ args: [String], path: String? = nil) -> (code: Int32, text: String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: tool)
    p.arguments = args
    if let path {
      var env = ProcessInfo.processInfo.environment
      env["PATH"] = path
      p.environment = env
    }
    // One pipe for both streams: reading them one after the other could block on a full pipe.
    let out = Pipe()
    p.standardOutput = out
    p.standardError = out
    do { try p.run() } catch { return (-1, error.localizedDescription) }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    let text = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    return (p.terminationStatus, text)
  }
}
