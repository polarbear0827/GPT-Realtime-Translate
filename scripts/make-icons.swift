// Builds every icon from assets/logo.png (transparent logo artwork):
//   src/macos/AppIcon.icns            macOS app icon: the logo on a dark superellipse plate (Apple's grid)
//   public/icons/logo-64.png          logo only, for the app's favicon and toolbar
//   relay/public/favicon-64.png       logo only, for the viewer page's tab
//   relay/public/logo-256.png         logo only, for the relay's landing page
//   relay/public/apple-touch-icon.png 180×180, full bleed (iOS rounds it), for "Add to Home Screen"
// Run: zsh scripts/make-icons.sh
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let root = URL(fileURLWithPath: CommandLine.arguments[1])
let workDir = URL(fileURLWithPath: CommandLine.arguments[2])
let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!

func load(_ url: URL) -> CGImage {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        fatalError("cannot read \(url.path)")
    }
    return image
}

func save(_ image: CGImage, _ url: URL) {
    try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, image, nil)
    CGImageDestinationFinalize(destination)
}

func canvas(_ width: Int, _ height: Int) -> CGContext {
    let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: sRGB, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.interpolationQuality = .high
    return context
}

// The artwork's bounding box (non-transparent pixels), so padding is measured from what's visible.
func trimmed(_ image: CGImage) -> CGImage {
    let width = image.width, height = image.height
    let context = canvas(width, height)
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    let pixels = context.data!.bindMemory(to: UInt8.self, capacity: width * height * 4)
    var minX = width, minY = height, maxX = 0, maxY = 0
    for y in 0..<height {
        for x in 0..<width where pixels[(y * width + x) * 4 + 3] > 8 {
            minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
        }
    }
    // Bitmap rows run top to bottom here, which matches CGImage.cropping.
    return image.cropping(to: CGRect(x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1))!
}

func superellipse(_ rect: CGRect, exponent: Double = 5) -> CGPath {
    let path = CGMutablePath()
    let steps = 1440
    for step in 0...steps {
        let t = Double(step) / Double(steps) * 2 * .pi
        let c = cos(t), s = sin(t)
        let x = rect.midX + rect.width / 2 * (c < 0 ? -1 : 1) * pow(abs(c), 2 / exponent)
        let y = rect.midY + rect.height / 2 * (s < 0 ? -1 : 1) * pow(abs(s), 2 / exponent)
        if step == 0 { path.move(to: CGPoint(x: x, y: y)) } else { path.addLine(to: CGPoint(x: x, y: y)) }
    }
    path.closeSubpath()
    return path
}

// Draws the logo centred in `box`, as large as fits within the given fractions of its width and height.
func drawLogo(_ logo: CGImage, in context: CGContext, box: CGRect, widthFraction: Double, heightFraction: Double, nudgeY: Double = 0) {
    let scale = min(box.width * widthFraction / Double(logo.width), box.height * heightFraction / Double(logo.height))
    let size = CGSize(width: Double(logo.width) * scale, height: Double(logo.height) * scale)
    context.draw(logo, in: CGRect(x: box.midX - size.width / 2, y: box.midY - size.height / 2 + nudgeY, width: size.width, height: size.height))
}

// Dark indigo with a soft glow behind the logo: the neon artwork reads well in light and dark Docks.
func drawPlateBackground(_ context: CGContext, _ rect: CGRect) {
    let gradient = CGGradient(colorSpace: sRGB, colorComponents: [0.075, 0.078, 0.16, 1, 0.13, 0.10, 0.27, 1], locations: [0, 1], count: 2)!
    context.drawLinearGradient(gradient, start: CGPoint(x: rect.midX, y: rect.maxY), end: CGPoint(x: rect.midX, y: rect.minY), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
    let glow = CGGradient(colorSpace: sRGB, colorComponents: [0.35, 0.30, 0.95, 0.35, 0.35, 0.30, 0.95, 0], locations: [0, 1], count: 2)!
    let center = CGPoint(x: rect.midX, y: rect.midY)
    context.drawRadialGradient(glow, startCenter: center, startRadius: 0, endCenter: center, endRadius: rect.width * 0.51, options: [])
}

func appIcon(_ logo: CGImage) -> CGImage {
    let context = canvas(1024, 1024)
    let plate = CGRect(x: 100, y: 100, width: 824, height: 824)
    let shape = superellipse(plate)
    context.saveGState()
    context.setShadow(offset: CGSize(width: 0, height: -12), blur: 28, color: CGColor(gray: 0, alpha: 0.45))
    context.addPath(shape)
    context.setFillColor(CGColor(gray: 0.1, alpha: 1))
    context.fillPath()
    context.restoreGState()
    context.saveGState()
    context.addPath(shape)
    context.clip()
    drawPlateBackground(context, plate)
    drawLogo(logo, in: context, box: plate, widthFraction: 0.76, heightFraction: 0.70, nudgeY: -4)
    context.restoreGState()
    context.addPath(shape)
    context.setStrokeColor(CGColor(gray: 1, alpha: 0.10))
    context.setLineWidth(2)
    context.strokePath()
    return context.makeImage()!
}

func touchIcon(_ logo: CGImage) -> CGImage {
    let context = canvas(180, 180)
    let rect = CGRect(x: 0, y: 0, width: 180, height: 180)
    drawPlateBackground(context, rect)
    drawLogo(logo, in: context, box: rect, widthFraction: 0.80, heightFraction: 0.74)
    return context.makeImage()!
}

func logoOnly(_ logo: CGImage, _ side: Int) -> CGImage {
    let context = canvas(side, side)
    drawLogo(logo, in: context, box: CGRect(x: 0, y: 0, width: side, height: side), widthFraction: 1, heightFraction: 1)
    return context.makeImage()!
}

func resized(_ image: CGImage, _ side: Int) -> CGImage {
    let context = canvas(side, side)
    context.draw(image, in: CGRect(x: 0, y: 0, width: side, height: side))
    return context.makeImage()!
}

let logo = trimmed(load(root.appendingPathComponent("assets/logo.png")))
let icon = appIcon(logo)
let iconset = workDir.appendingPathComponent("AppIcon.iconset")
for (points, scale) in [(16, 1), (16, 2), (32, 1), (32, 2), (128, 1), (128, 2), (256, 1), (256, 2), (512, 1), (512, 2)] {
    let name = scale == 1 ? "icon_\(points)x\(points).png" : "icon_\(points)x\(points)@2x.png"
    save(resized(icon, points * scale), iconset.appendingPathComponent(name))
}
save(icon, workDir.appendingPathComponent("AppIcon-1024.png"))
save(logoOnly(logo, 64), root.appendingPathComponent("public/icons/logo-64.png"))
save(logoOnly(logo, 64), root.appendingPathComponent("relay/public/favicon-64.png"))
save(logoOnly(logo, 256), root.appendingPathComponent("relay/public/logo-256.png"))
save(touchIcon(logo), root.appendingPathComponent("relay/public/apple-touch-icon.png"))
print("icons written")
