import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  let port = resolvePort(env: ProcessInfo.processInfo.environment, defaultsPort: UserDefaults.standard.integer(forKey: "port"))
  lazy var web = WebController(port: port)
  lazy var window = MainWindow(content: web.webView)

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.mainMenu = mainMenu()
    window.show()
    web.load()
    NSApp.activate()
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    window.show()
    return true
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    false
  }

  @objc func reload(_ sender: Any?) {
    web.webView.reload()
  }

  // ⌘K has no item here, so it reaches the dashboard's command bar.
  private func mainMenu() -> NSMenu {
    let bar = NSMenu()
    func submenu(_ title: String, _ items: [NSMenuItem]) -> NSMenu {
      let menu = NSMenu(title: title)
      items.forEach(menu.addItem)
      let top = NSMenuItem(title: title, action: nil, keyEquivalent: "")
      top.submenu = menu
      bar.addItem(top)
      return menu
    }
    func item(_ title: String, _ action: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
      let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
      i.keyEquivalentModifierMask = mods
      return i
    }

    _ = submenu(
      "Atrium",
      [
        item("About Atrium", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
        .separator(),
        item("Hide Atrium", #selector(NSApplication.hide(_:)), "h"),
        item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
        .separator(),
        item("Quit Atrium", #selector(NSApplication.terminate(_:)), "q"),
      ])
    _ = submenu(
      "Edit",
      [
        item("Undo", Selector(("undo:")), "z"),
        item("Redo", Selector(("redo:")), "z", [.command, .shift]),
        .separator(),
        item("Cut", #selector(NSText.cut(_:)), "x"),
        item("Copy", #selector(NSText.copy(_:)), "c"),
        item("Paste", #selector(NSText.paste(_:)), "v"),
        item("Select All", #selector(NSText.selectAll(_:)), "a"),
      ])
    let reload = item("Reload", #selector(reload(_:)), "r")
    reload.target = self
    _ = submenu("View", [reload])
    NSApp.windowsMenu = submenu(
      "Window",
      [
        item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
        item("Close", #selector(NSWindow.performClose(_:)), "w"),
        item("Zoom", #selector(NSWindow.performZoom(_:))),
      ])
    return bar
  }
}
