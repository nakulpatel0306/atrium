import AppKit
import ServiceManagement

// `atrium app uninstall` runs this first, so removing the app never leaves a login item behind.
if CommandLine.arguments.contains("--unregister-login") {
  try? SMAppService.mainApp.unregister()
  exit(0)
}

MainActor.assumeIsolated {
  let app = NSApplication.shared
  let delegate = AppDelegate()
  app.delegate = delegate
  app.setActivationPolicy(.regular)
  app.run()
}
