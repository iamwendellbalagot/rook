// Development-only artwork conversion; no Swift/PNG dependency at runtime.
// swift scripts/generate-home-brand.swift <rook_lockup.png> [preview.png]
// Prints seven rows of mask/foreground/background cells for home-brand.ts.
import AppKit

struct Pixel {
    var r: Double, g: Double, b: Double, a: Double
    var color: NSColor { NSColor(srgbRed: r, green: g, blue: b, alpha: 1) }
    var hex: String {
        String(format: "%02X%02X%02X", Int((r * 255).rounded()),
               Int((g * 255).rounded()), Int((b * 255).rounded()))
    }
    var lightness: Double { r * 0.2126 + g * 0.7152 + b * 0.0722 }
    func distance(_ p: Pixel) -> Double {
        (r - p.r) * (r - p.r) + (g - p.g) * (g - p.g) + (b - p.b) * (b - p.b)
    }
}

func mean(_ pixels: [Pixel]) -> Pixel {
    let n = Double(pixels.count)
    return Pixel(r: pixels.reduce(0) { $0 + $1.r } / n,
                 g: pixels.reduce(0) { $0 + $1.g } / n,
                 b: pixels.reduce(0) { $0 + $1.b } / n, a: 1)
}

let image = NSBitmapImageRep(data: try Data(contentsOf:
    URL(fileURLWithPath: CommandLine.arguments[1])))!
var left = image.pixelsWide, top = image.pixelsHigh, right = 0, bottom = 0
for y in 0..<image.pixelsHigh {
    for x in 0..<image.pixelsWide where image.colorAt(x: x, y: y)!.alphaComponent > 0.1 {
        left = min(left, x); top = min(top, y)
        right = max(right, x); bottom = max(bottom, y)
    }
}

// Same 36×7 terminal footprint; Braille supplies 2×4 samples per cell.
let width = 72, height = 28
var pixels = [Pixel]()
for y in 0..<height {
    for x in 0..<width {
        let x0 = left + x * (right - left + 1) / width
        let x1 = left + (x + 1) * (right - left + 1) / width
        let y0 = top + y * (bottom - top + 1) / height
        let y1 = top + (y + 1) * (bottom - top + 1) / height
        var r = 0.0, g = 0.0, b = 0.0, a = 0.0
        for sy in y0..<y1 { for sx in x0..<x1 {
            let c = image.colorAt(x: sx, y: sy)!.usingColorSpace(.sRGB)!
            let alpha = c.alphaComponent
            a += alpha; r += c.redComponent * alpha
            g += c.greenComponent * alpha; b += c.blueComponent * alpha
        }}
        pixels.append(Pixel(r: a > 0 ? r / a : 0, g: a > 0 ? g / a : 0,
                            b: a > 0 ? b / a : 0,
                            a: a / Double((x1 - x0) * (y1 - y0))))
    }
}

let bits = [1, 8, 2, 16, 4, 32, 64, 128]
var preview = [[(String, Pixel?, Pixel?)]]()
for row in 0..<7 {
    var tokens = [String](), cells = [(String, Pixel?, Pixel?)]()
    for column in 0..<36 {
        var cell = [Pixel]()
        for index in 0..<8 {
            let py = row * 4 + index / 2
            let px = column * 2 + index % 2
            cell.append(pixels[py * width + px])
        }
        let visible = cell.filter { $0.a >= 0.35 }
        guard !visible.isEmpty else {
            tokens.append("-"); cells.append((" ", nil, nil)); continue
        }
        var fg = mean(visible), bg: Pixel? = nil
        var mask = cell.enumerated().reduce(0) { $0 | ($1.element.a >= 0.35 ? bits[$1.offset] : 0) }
        // Don't muddy the ivory/cyan edges with the PNG's dark outline.
        if column >= 14 && visible.count < 8 {
            let brightest = visible.sorted { $0.lightness > $1.lightness }
            fg = mean(Array(brightest.prefix(max(1, brightest.count / 2))))
        }
        if visible.count == 8 {
            // Two adaptive colors preserve shading, solid fills, and fine edges.
            var low = visible.min { $0.lightness < $1.lightness }!
            var high = visible.max { $0.lightness < $1.lightness }!
            for _ in 0..<6 {
                let darker = visible.filter { $0.distance(low) <= $0.distance(high) }
                let lighter = visible.filter { $0.distance(low) > $0.distance(high) }
                if !darker.isEmpty { low = mean(darker) }
                if !lighter.isEmpty { high = mean(lighter) }
            }
            if low.distance(high) > 0.025 {
                fg = high; bg = low
                mask = cell.enumerated().reduce(0) {
                    $0 | ($1.element.distance(high) < $1.element.distance(low) ? bits[$1.offset] : 0)
                }
                if mask.nonzeroBitCount > 4 {
                    fg = low; bg = high; mask ^= 255
                }
            }
        }
        let quadrants = [0x00: " ", 0x03: "▘", 0x18: "▝", 0x1B: "▀",
                         0x44: "▖", 0x47: "▌", 0x5C: "▞", 0x5F: "▛",
                         0xA0: "▗", 0xA3: "▚", 0xB8: "▐", 0xBB: "▜",
                         0xE4: "▄", 0xE7: "▙", 0xFC: "▟", 0xFF: "█"]
        let glyph = quadrants[mask] ?? String(UnicodeScalar(0x2800 + mask)!)
        tokens.append(String(format: "%02X", mask) + "/" + fg.hex + "/" + (bg?.hex ?? "-"))
        cells.append((glyph, fg, bg))
    }
    print("  \"" + tokens.joined(separator: " ") + "\",")
    preview.append(cells)
}

if CommandLine.arguments.count > 2 {
    // Approximate terminal preview using actual monospaced glyphs, not pixels.
    let font = NSFont(name: "Menlo-Regular", size: 28)!
    let cw = ("M" as NSString).size(withAttributes: [.font: font]).width
    let ch = 36.0, margin = 20.0
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(cw * 36 + margin * 2),
        pixelsHigh: Int(ch * 7 + margin * 2), bitsPerSample: 8, samplesPerPixel: 4,
        hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSColor(srgbRed: 0.025, green: 0.045, blue: 0.08, alpha: 1).setFill()
    NSRect(x: 0, y: 0, width: rep.pixelsWide, height: rep.pixelsHigh).fill()
    for (y, row) in preview.enumerated() { for (x, cell) in row.enumerated() {
        let origin = NSPoint(x: margin + Double(x) * cw, y: margin + Double(6 - y) * ch)
        if let bg = cell.2 { bg.color.setFill(); NSRect(origin: origin, size: NSSize(width: cw, height: ch)).fill() }
        if let fg = cell.1 { (cell.0 as NSString).draw(at: origin, withAttributes: [.font: font, .foregroundColor: fg.color]) }
    }}
    NSGraphicsContext.restoreGraphicsState()
    try rep.representation(using: .png, properties: [:])!.write(to:
        URL(fileURLWithPath: CommandLine.arguments[2]))
}
