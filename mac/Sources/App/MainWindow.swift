import AppKit

extension NSColor {
  // The dashboard's --bg, so the strip above the web view and the web view read as one surface.
  static var atriumBackground: NSColor { NSColor(srgbRed: 0x0d / 255, green: 0x0d / 255, blue: 0x0f / 255, alpha: 1) }
}

@MainActor
final class MainWindow: NSObject, NSWindowDelegate {
  let window: NSWindow

  init(content: NSView) {
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800),
      styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    super.init()
    // A title-less dark strip above the web view, not .fullSizeContentView: the traffic lights stay clear of the
    // sidebar and the strip drags the window.
    window.title = "Atrium"
    window.titlebarAppearsTransparent = true
    window.titleVisibility = .hidden
    window.appearance = NSAppearance(named: .darkAqua)
    window.backgroundColor = .atriumBackground
    window.minSize = NSSize(width: 900, height: 600)
    window.isReleasedWhenClosed = false
    window.delegate = self
    window.contentView = content
    window.center()
    window.setFrameAutosaveName("AtriumMain")
  }

  func show() {
    window.makeKeyAndOrderFront(nil)
  }

  func setContent(_ v: NSView) {
    guard window.contentView !== v else { return }
    window.contentView = v
  }

  // Closing only hides: the app keeps its badge, menu and notifications until ⌘Q.
  func windowShouldClose(_ sender: NSWindow) -> Bool {
    sender.orderOut(nil)
    return false
  }
}
