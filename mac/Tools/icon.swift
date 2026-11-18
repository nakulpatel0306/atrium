import AppKit

// Renders the app icon at 1024 px from a still of Plum (mac/Tools/plum.png, rendered from the site's 3D model), on
// the dashboard's violet ground, so the icon needs no Xcode.
let args = CommandLine.arguments
guard args.count == 3 else {
  FileHandle.standardError.write("Usage: icon <plum.png> <out.png>\n".data(using: .utf8)!)
  exit(2)
}
guard let plum = NSImage(contentsOfFile: args[1]) else {
  FileHandle.standardError.write("Couldn't read \(args[1]) as an image.\n".data(using: .utf8)!)
  exit(1)
}

let size = 1024
let rep = NSBitmapImageRep(
  bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4,
  hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
rep.size = NSSize(width: size, height: size)
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
let tile = NSBezierPath(roundedRect: NSRect(x: 100, y: 100, width: 824, height: 824), xRadius: 185, yRadius: 185)
NSColor(srgbRed: 0x0c / 255, green: 0x0a / 255, blue: 0x14 / 255, alpha: 1).setFill()
tile.fill()
// The soft purple pool Plum stands in on the site, clipped to the tile.
tile.addClip()
let glow = NSGradient(colors: [NSColor(srgbRed: 140 / 255, green: 110 / 255, blue: 1, alpha: 0.55), NSColor(srgbRed: 140 / 255, green: 110 / 255, blue: 1, alpha: 0)])!
glow.draw(in: NSBezierPath(ovalIn: NSRect(x: 192, y: 170, width: 640, height: 220)), relativeCenterPosition: .zero)
plum.draw(in: NSRect(x: 242, y: 214, width: 540, height: 540))
NSGraphicsContext.restoreGraphicsState()

guard let png = rep.representation(using: .png, properties: [:]) else { exit(1) }
try png.write(to: URL(fileURLWithPath: args[2]))
