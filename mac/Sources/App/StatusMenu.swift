import AppKit
import ServiceManagement

// The menu is rebuilt only when Nakul opens it; between opens the status item just shows the count.
@MainActor
final class StatusMenu: NSObject, NSMenuDelegate {
  private let client: EngineClient
  private let open: (_ path: String) -> Void
  private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  private var online = false
  private var summary: Summary?
  var notifier: Notifier?

  init(client: EngineClient, open: @escaping (_ path: String) -> Void) {
    self.client = client
    self.open = open
    super.init()
    if let button = item.button {
      if let url = Bundle.main.url(forResource: "logo-mark", withExtension: "svg"), let image = NSImage(contentsOf: url) {
        image.isTemplate = true
        image.size = NSSize(width: 16, height: 16)
        button.image = image
      }
      button.imagePosition = .imageLeading
      button.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
    }
    let menu = NSMenu()
    menu.delegate = self
    menu.autoenablesItems = false
    item.menu = menu
    update(online: false, summary: nil)
  }

  func update(online: Bool, summary: Summary?) {
    self.online = online
    self.summary = summary
    item.button?.title = statusTitle(online ? summary?.needsYou : nil)
    item.button?.appearsDisabled = !online
  }

  func menuNeedsUpdate(_ menu: NSMenu) {
    menu.removeAllItems()
    let s = online ? summary : nil

    let header = NSMenuItem(title: headerTitle(s), action: nil, keyEquivalent: "")
    header.isEnabled = false
    menu.addItem(header)
    menu.addItem(action("Open Atrium", #selector(openPath(_:)), key: "o", path: "/"))

    if let s, !s.needs.isEmpty {
      menu.addItem(.separator())
      let (shown, more) = menuNeeds(s)
      for n in shown { menu.addItem(action(needTitle(n), #selector(openPath(_:)), path: n.path)) }
      if more > 0 { menu.addItem(action("\(more) more…", #selector(openPath(_:)), path: "/")) }
    }

    menu.addItem(.separator())
    let overnight = action("Overnight mode", #selector(toggleOvernight))
    overnight.state = s?.overnight == true ? .on : .off
    overnight.isEnabled = s != nil
    menu.addItem(overnight)
    if notifier?.isAllowed == false {
      let off = NSMenuItem(title: "Notifications are off", action: nil, keyEquivalent: "")
      off.isEnabled = false
      menu.addItem(off)
      menu.addItem(action("Open Notification Settings…", #selector(openNotificationSettings)))
    }
    let login = action("Open at Login", #selector(toggleLogin))
    login.state = SMAppService.mainApp.status == .enabled ? .on : .off
    menu.addItem(login)

    menu.addItem(.separator())
    menu.addItem(action("Quit Atrium", #selector(NSApplication.terminate(_:)), key: "q", target: NSApp))
  }

  private func headerTitle(_ s: Summary?) -> String {
    guard let s else { return "Engine isn't running" }
    switch s.needsYou {
    case 0: return "Nothing needs you"
    case 1: return "1 thing needs you"
    default: return "\(s.needsYou) things need you"
    }
  }

  private func action(_ title: String, _ selector: Selector, key: String = "", path: String? = nil, target: AnyObject? = nil) -> NSMenuItem {
    let i = NSMenuItem(title: title, action: selector, keyEquivalent: key)
    i.target = target ?? self
    i.representedObject = path
    return i
  }

  @objc private func openPath(_ sender: NSMenuItem) {
    open(sender.representedObject as? String ?? "/")
  }

  @objc private func openNotificationSettings() {
    NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension")!)
  }

  @objc private func toggleOvernight() {
    guard let s = summary else { return }
    Task {
      do {
        try await client.post("/api/settings", ["overnight": !s.overnight])
      } catch {
        alert(error.localizedDescription)
      }
    }
  }

  @objc private func toggleLogin() {
    do {
      if SMAppService.mainApp.status == .enabled {
        try SMAppService.mainApp.unregister()
      } else {
        try SMAppService.mainApp.register()
      }
    } catch {
      alert("Couldn't change Open at Login: \(error.localizedDescription). You can set it in System Settings › General › Login Items.")
    }
  }

  private func alert(_ text: String) {
    let a = NSAlert()
    a.messageText = text
    a.runModal()
  }
}
