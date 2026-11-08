import AppKit

// Renders the dashboard's logo mark as a 1024 px app icon, so the icon has one source and needs no Xcode.
let args = CommandLine.arguments
guard args.count == 3 else {
  FileHandle.standardError.write("Usage: icon <logo.svg> <out.png>\n".data(using: .utf8)!)
  exit(2)
}

// NSImage ignores the SVG's <style>, so the color the dashboard picks per theme is fixed here.
var svg = try String(contentsOfFile: args[1], encoding: .utf8)
svg = svg.replacingOccurrences(of: "<style>[\\s\\S]*?</style>", with: "", options: .regularExpression)
svg = svg.replacingOccurrences(of: "fill=\"currentColor\"", with: "fill=\"#e6e6ea\"")
// The center square is the mark's one spot of the accent, as in the dashboard and on the site.
svg = svg.replacingOccurrences(of: "<rect x=\"8.75\"", with: "<rect fill=\"#7c7cf5\" x=\"8.75\"")
guard let mark = NSImage(data: Data(svg.utf8)) else {
  FileHandle.standardError.write("Couldn't read \(args[1]) as an SVG.\n".data(using: .utf8)!)
  exit(1)
}

let size = 1024
let rep = NSBitmapImageRep(
  bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4,
  hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
rep.size = NSSize(width: size, height: size)
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
NSColor(srgbRed: 0x14 / 255, green: 0x14 / 255, blue: 0x17 / 255, alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: 100, y: 100, width: 824, height: 824), xRadius: 185, yRadius: 185).fill()
mark.draw(in: NSRect(x: 252, y: 252, width: 520, height: 520))
NSGraphicsContext.restoreGraphicsState()

guard let png = rep.representation(using: .png, properties: [:]) else { exit(1) }
try png.write(to: URL(fileURLWithPath: args[2]))
