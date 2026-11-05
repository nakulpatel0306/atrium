import AppKit
import UserNotifications

@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
  private let open: (String) -> Void
  // nil until macOS says: an unanswered prompt shouldn't read as "off".
  private(set) var isAllowed: Bool?

  init(open: @escaping (String) -> Void) {
    self.open = open
    super.init()
    UNUserNotificationCenter.current().delegate = self
    // Nakul may turn notifications on in System Settings while the app runs; the menu row should follow.
    NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) {
      [weak self] _ in
      MainActor.assumeIsolated { self?.refresh() }
    }
    refresh()
  }

  // .badge too: once an app has asked for notifications, the Dock hides its badge unless badges were granted.
  // A refusal isn't shown; the menu says notifications are off.
  func authorize() {
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { [weak self] granted, _ in
      Task { @MainActor in self?.isAllowed = granted }
    }
  }

  func post(_ notes: [Note]) {
    for note in notes {
      let content = UNMutableNotificationContent()
      content.title = note.title
      content.body = note.body
      content.sound = .default
      content.threadIdentifier = "atrium"
      content.userInfo = ["path": note.path]
      // The note's id as identifier: a repeat replaces the banner instead of stacking another.
      UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: note.id, content: content, trigger: nil))
    }
  }

  private func refresh() {
    UNUserNotificationCenter.current().getNotificationSettings { [weak self] settings in
      let allowed: Bool? =
        switch settings.authorizationStatus {
        case .authorized, .provisional: true
        case .denied: false
        default: nil
        }
      Task { @MainActor in self?.isAllowed = allowed }
    }
  }

  nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
    let path = response.notification.request.content.userInfo["path"] as? String ?? "/"
    await MainActor.run { open(path) }
  }

  // Nakul is already looking at the dashboard when the window is key, so a banner would only repeat it.
  nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async
    -> UNNotificationPresentationOptions
  {
    await MainActor.run { NSApp.isActive && NSApp.keyWindow?.isVisible == true ? [] : [.banner, .sound] }
  }
}
