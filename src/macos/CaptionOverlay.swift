import AppKit

// Floating caption window: frosted glass, always on top, shown on every Space including other apps'
// full-screen video, never takes keyboard focus. Large translation (2 lines) with the original below
// (1 line, smaller). Hover reveals size / lock / close controls; "lock" makes it click-through.

struct OverlayLine: Equatable {
    let sentences: [String]
    let cjk: Bool
    let lang: String

    init(sentences: [String], cjk: Bool, lang: String) {
        self.sentences = sentences
        self.cjk = cjk
        self.lang = lang
    }

    init?(json: Any?) {
        guard let object = json as? [String: Any], let sentences = object["sentences"] as? [String] else { return nil }
        self.init(sentences: sentences, cjk: object["cjk"] as? Bool ?? false, lang: object["lang"] as? String ?? "")
    }

    var isEmpty: Bool { sentences.allSatisfy { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } }
}

/// Chooses what fits: the longest run of trailing whole sentences within `maxLines`; when even the last
/// sentence is too long, its end prefixed with "…" (subtitles show the newest words, never cut the end).
enum OverlayTextFitter {
    static func fit(_ sentences: [String], cjk: Bool, attributes: [NSAttributedString.Key: Any], width: CGFloat, maxLines: Int) -> String {
        let clean = sentences.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        guard let last = clean.last, width > 20 else { return "" }
        let limit = lineHeight(attributes) * CGFloat(maxLines) + 1
        let separator = cjk ? "" : " "
        for count in stride(from: clean.count, through: 1, by: -1) {
            let text = clean.suffix(count).joined(separator: separator)
            if height(text, attributes, width) <= limit { return text }
        }
        let characters = Array(last)
        var low = 1
        var high = characters.count
        while low < high {
            let mid = (low + high) / 2
            if height("…" + String(characters[mid...]), attributes, width) <= limit { high = mid } else { low = mid + 1 }
        }
        var tail = String(characters[min(low, characters.count - 1)...])
        if !cjk, let space = tail.firstIndex(of: " "), tail.distance(from: tail.startIndex, to: space) < 20 {
            tail = String(tail[tail.index(after: space)...])
        }
        return "…" + tail
    }

    static func lineHeight(_ attributes: [NSAttributedString.Key: Any]) -> CGFloat {
        height("Ag國", attributes, .greatestFiniteMagnitude)
    }

    static func height(_ text: String, _ attributes: [NSAttributedString.Key: Any], _ width: CGFloat) -> CGFloat {
        NSAttributedString(string: text, attributes: attributes)
            .boundingRect(with: NSSize(width: width, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading])
            .height.rounded(.up)
    }
}

enum OverlayStyle {
    static let primaryBaseSize: CGFloat = 30
    static let secondaryRatio: CGFloat = 0.54
    static let horizontalInset: CGFloat = 28
    static let verticalInset: CGFloat = 14
    static let spacing: CGFloat = 5

    static func font(lang: String, size: CGFloat, bold: Bool) -> NSFont {
        let names: [String: (String, String)] = [
            "zh": ("PingFangTC-Semibold", "PingFangTC-Regular"),
            "ja": ("HiraginoSans-W6", "HiraginoSans-W3"),
            "ko": ("AppleSDGothicNeo-SemiBold", "AppleSDGothicNeo-Regular"),
        ]
        if let pair = names[String(lang.prefix(2))], let font = NSFont(name: bold ? pair.0 : pair.1, size: size) {
            return font
        }
        return .systemFont(ofSize: size, weight: bold ? .semibold : .regular)
    }

    static func primaryAttributes(lang: String, scale: CGFloat, placeholder: Bool = false) -> [NSAttributedString.Key: Any] {
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        paragraph.lineBreakMode = .byWordWrapping
        paragraph.lineHeightMultiple = 1.04
        let shadow = NSShadow()
        shadow.shadowColor = NSColor.black.withAlphaComponent(0.45)
        shadow.shadowBlurRadius = 4
        shadow.shadowOffset = NSSize(width: 0, height: -1)
        let size = primaryBaseSize * scale * (placeholder ? 0.62 : 1)
        return [
            .font: font(lang: lang, size: size, bold: !placeholder),
            .foregroundColor: NSColor.white.withAlphaComponent(placeholder ? 0.4 : 0.98),
            .paragraphStyle: paragraph,
            .shadow: shadow,
        ]
    }

    static func secondaryAttributes(lang: String, scale: CGFloat) -> [NSAttributedString.Key: Any] {
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        paragraph.lineBreakMode = .byTruncatingHead
        return [
            .font: font(lang: lang, size: max(12, primaryBaseSize * scale * secondaryRatio), bold: false),
            .foregroundColor: NSColor.white.withAlphaComponent(0.72),
            .paragraphStyle: paragraph,
        ]
    }

    /// Fixed height for two primary lines plus one secondary line, so the box never jumps as text changes.
    static func preferredHeight(scale: CGFloat) -> CGFloat {
        let primary = OverlayTextFitter.lineHeight(primaryAttributes(lang: "zh", scale: scale))
        let secondary = OverlayTextFitter.lineHeight(secondaryAttributes(lang: "zh", scale: scale))
        return (verticalInset * 2 + primary * 2 + spacing + secondary).rounded(.up)
    }
}

/// Draws the fitted caption text; measuring and drawing use the same text engine.
final class CaptionTextView: NSView {
    var primary: OverlayLine? { didSet { needsDisplay = true } }
    var secondary: OverlayLine? { didSet { needsDisplay = true } }
    var scale: CGFloat = 1 { didSet { needsDisplay = true } }

    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func draw(_ dirtyRect: NSRect) {
        let width = bounds.width
        var blocks: [(NSAttributedString, CGFloat)] = []
        if let primary, !primary.isEmpty {
            let attributes = OverlayStyle.primaryAttributes(lang: primary.lang, scale: scale)
            let text = OverlayTextFitter.fit(primary.sentences, cjk: primary.cjk, attributes: attributes, width: width, maxLines: 2)
            blocks.append((NSAttributedString(string: text, attributes: attributes), OverlayTextFitter.height(text, attributes, width)))
        }
        if let secondary, !secondary.isEmpty {
            let attributes = OverlayStyle.secondaryAttributes(lang: secondary.lang, scale: scale)
            let text = OverlayTextFitter.fit(secondary.sentences, cjk: secondary.cjk, attributes: attributes, width: width, maxLines: 1)
            blocks.append((NSAttributedString(string: text, attributes: attributes), OverlayTextFitter.lineHeight(attributes)))
        }
        if blocks.isEmpty {
            let attributes = OverlayStyle.primaryAttributes(lang: "zh", scale: scale, placeholder: true)
            let text = "等待聲音…"
            blocks.append((NSAttributedString(string: text, attributes: attributes), OverlayTextFitter.height(text, attributes, width)))
        }
        let total = blocks.reduce(0) { $0 + $1.1 } + OverlayStyle.spacing * CGFloat(blocks.count - 1)
        var y = ((bounds.height - total) / 2).rounded()
        for (text, height) in blocks {
            text.draw(with: NSRect(x: 0, y: y, width: width, height: height), options: [.usesLineFragmentOrigin, .usesFontLeading, .truncatesLastVisibleLine])
            y += height + OverlayStyle.spacing
        }
    }
}

final class OverlayPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class OverlayBackgroundView: NSVisualEffectView {
    var onHover: ((Bool) -> Void)?
    private var trackingArea: NSTrackingArea?

    override var mouseDownCanMoveWindow: Bool { true }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let trackingArea { removeTrackingArea(trackingArea) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(area)
        trackingArea = area
    }

    override func mouseEntered(with event: NSEvent) { onHover?(true) }
    override func mouseExited(with event: NSEvent) { onHover?(false) }
}

final class OverlayButton: NSButton {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

@MainActor
final class CaptionOverlay: NSObject {
    struct State: Equatable {
        var visible = false
        var locked = false
        var fontScale: Double = 1

        var json: [String: Any] { ["visible": visible, "locked": locked, "fontScale": fontScale] }
    }

    var onStateChange: ((State) -> Void)?
    private(set) var state: State
    private var panel: OverlayPanel?
    private let textView = CaptionTextView()
    private let controls = NSStackView()
    private var lockButton: OverlayButton?
    private let defaults = UserDefaults.standard

    override init() {
        state = State(
            visible: false,
            locked: UserDefaults.standard.bool(forKey: "overlay.locked"),
            fontScale: UserDefaults.standard.object(forKey: "overlay.fontScale") as? Double ?? 1
        )
        super.init()
    }

    func apply(visible: Bool? = nil, locked: Bool? = nil, fontScale: Double? = nil) {
        var next = state
        if let locked { next.locked = locked }
        if let fontScale { next.fontScale = min(2.2, max(0.6, (fontScale * 10).rounded() / 10)) }
        if let visible { next.visible = visible }
        guard next != state else { return }
        let scaleChanged = next.fontScale != state.fontScale
        state = next
        defaults.set(state.locked, forKey: "overlay.locked")
        defaults.set(state.fontScale, forKey: "overlay.fontScale")

        if state.visible {
            let panel = panel ?? makePanel()
            panel.ignoresMouseEvents = state.locked
            textView.scale = CGFloat(state.fontScale)
            if scaleChanged { fitHeight() }
            updateLockButton()
            if !panel.isVisible {
                panel.alphaValue = 0
                panel.orderFrontRegardless()
                NSAnimationContext.runAnimationGroup { context in
                    context.duration = 0.18
                    panel.animator().alphaValue = 1
                }
            }
        } else {
            panel?.orderOut(nil)
        }
        onStateChange?(state)
    }

    func update(primary: OverlayLine?, secondary: OverlayLine?) {
        if textView.primary != primary { textView.primary = primary }
        if textView.secondary != secondary { textView.secondary = secondary }
    }

    // ---- window -------------------------------------------------------------------------------

    private func makePanel() -> OverlayPanel {
        let visible = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let width = min(visible.width * 0.62, 1080)
        let height = OverlayStyle.preferredHeight(scale: CGFloat(state.fontScale))
        let frame = NSRect(x: visible.midX - width / 2, y: visible.minY + 56, width: width, height: height)
        let panel = OverlayPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel, .resizable], backing: .buffered, defer: false)
        panel.isFloatingPanel = true
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.hidesOnDeactivate = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.isMovableByWindowBackground = true
        panel.isReleasedWhenClosed = false
        panel.minSize = NSSize(width: 360, height: 64)
        panel.animationBehavior = .utilityWindow
        panel.setFrameUsingName("CaptionOverlay")
        panel.setFrameAutosaveName("CaptionOverlay")

        let background = OverlayBackgroundView()
        background.material = .hudWindow
        background.blendingMode = .behindWindow
        background.state = .active
        background.appearance = NSAppearance(named: .vibrantDark)
        background.maskImage = Self.roundedMask(radius: 18)
        background.onHover = { [weak self] hovering in self?.setControlsVisible(hovering) }
        panel.contentView = background

        textView.scale = CGFloat(state.fontScale)
        textView.translatesAutoresizingMaskIntoConstraints = false
        background.addSubview(textView)
        NSLayoutConstraint.activate([
            textView.leadingAnchor.constraint(equalTo: background.leadingAnchor, constant: OverlayStyle.horizontalInset),
            textView.trailingAnchor.constraint(equalTo: background.trailingAnchor, constant: -OverlayStyle.horizontalInset),
            textView.topAnchor.constraint(equalTo: background.topAnchor, constant: OverlayStyle.verticalInset),
            textView.bottomAnchor.constraint(equalTo: background.bottomAnchor, constant: -OverlayStyle.verticalInset),
        ])
        buildControls(in: background)

        self.panel = panel
        fitHeight()
        return panel
    }

    /// Keeps the bottom edge where it is and sets the height for the current font size.
    private func fitHeight() {
        guard let panel else { return }
        var frame = panel.frame
        frame.size.height = OverlayStyle.preferredHeight(scale: CGFloat(state.fontScale))
        panel.setFrame(frame, display: true, animate: panel.isVisible)
    }

    private func buildControls(in background: NSView) {
        let items: [(String, String, Selector)] = [
            ("textformat.size.smaller", "縮小字幕", #selector(smaller)),
            ("textformat.size.larger", "放大字幕", #selector(larger)),
            ("lock.open", "鎖定位置（滑鼠可穿透）", #selector(toggleLock)),
            ("xmark", "關閉懸浮字幕", #selector(close)),
        ]
        let configuration = NSImage.SymbolConfiguration(pointSize: 12, weight: .semibold)
        for (symbol, tooltip, action) in items {
            let button = OverlayButton()
            button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: tooltip)?.withSymbolConfiguration(configuration)
            button.isBordered = false
            button.contentTintColor = NSColor.white.withAlphaComponent(0.88)
            button.toolTip = tooltip
            button.target = self
            button.action = action
            button.translatesAutoresizingMaskIntoConstraints = false
            button.widthAnchor.constraint(equalToConstant: 26).isActive = true
            button.heightAnchor.constraint(equalToConstant: 22).isActive = true
            if action == #selector(toggleLock) { lockButton = button }
            controls.addArrangedSubview(button)
        }
        controls.orientation = .horizontal
        controls.spacing = 2
        controls.edgeInsets = NSEdgeInsets(top: 2, left: 6, bottom: 2, right: 6)
        controls.wantsLayer = true
        controls.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.38).cgColor
        controls.layer?.cornerRadius = 9
        controls.alphaValue = 0
        controls.translatesAutoresizingMaskIntoConstraints = false
        background.addSubview(controls)
        NSLayoutConstraint.activate([
            controls.topAnchor.constraint(equalTo: background.topAnchor, constant: 8),
            controls.trailingAnchor.constraint(equalTo: background.trailingAnchor, constant: -10),
        ])
    }

    private func setControlsVisible(_ visible: Bool) {
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.15
            controls.animator().alphaValue = visible ? 1 : 0
        }
    }

    private func updateLockButton() {
        let symbol = state.locked ? "lock" : "lock.open"
        lockButton?.image = NSImage(systemSymbolName: symbol, accessibilityDescription: "鎖定")?
            .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 12, weight: .semibold))
    }

    @objc private func smaller() { apply(fontScale: state.fontScale - 0.1) }
    @objc private func larger() { apply(fontScale: state.fontScale + 0.1) }
    @objc private func toggleLock() { apply(locked: !state.locked) }
    @objc private func close() { apply(visible: false) }

    private static func roundedMask(radius: CGFloat) -> NSImage {
        let edge = radius * 2 + 1
        let image = NSImage(size: NSSize(width: edge, height: edge), flipped: false) { rect in
            NSColor.black.setFill()
            NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
            return true
        }
        image.capInsets = NSEdgeInsets(top: radius, left: radius, bottom: radius, right: radius)
        image.resizingMode = .stretch
        return image
    }
}
