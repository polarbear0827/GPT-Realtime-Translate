import AppKit

// Floating caption window: frosted glass, always on top, shown on every Space including other apps'
// full-screen video, never takes keyboard focus. The translation is shown large with the original in a
// smaller line below.
// Responsive: the text size follows the window height (resize from any edge or the corner grip) and the
// line width follows the window width. Hover reveals size, opacity, lock (click-through) and close.

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
    static let secondaryRatio: CGFloat = 0.54
    static let horizontalInset: CGFloat = 28
    static let verticalInset: CGFloat = 14
    static let spacing: CGFloat = 5
    static let defaultPrimarySize: CGFloat = 30
    static let minimumPrimarySize: CGFloat = 12
    static let maximumPrimarySize: CGFloat = 160

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

    /// `backdrop` is the background opacity: over a faint background the text gets a stronger shadow.
    static func primaryAttributes(lang: String, size: CGFloat, backdrop: CGFloat = 1, placeholder: Bool = false) -> [NSAttributedString.Key: Any] {
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        paragraph.lineBreakMode = .byWordWrapping
        paragraph.lineHeightMultiple = 1.04
        return [
            .font: font(lang: lang, size: size * (placeholder ? 0.62 : 1), bold: !placeholder),
            .foregroundColor: NSColor.white.withAlphaComponent(placeholder ? 0.45 : 0.98),
            .paragraphStyle: paragraph,
            .shadow: shadow(backdrop: backdrop, size: size),
        ]
    }

    static func secondaryAttributes(lang: String, primarySize: CGFloat, backdrop: CGFloat = 1) -> [NSAttributedString.Key: Any] {
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        paragraph.lineBreakMode = .byTruncatingHead
        let size = max(11, primarySize * secondaryRatio)
        return [
            .font: font(lang: lang, size: size, bold: false),
            .foregroundColor: NSColor.white.withAlphaComponent(0.6 + 0.2 * (1 - backdrop)),
            .paragraphStyle: paragraph,
            .shadow: shadow(backdrop: backdrop, size: size),
        ]
    }

    private static func shadow(backdrop: CGFloat, size: CGFloat) -> NSShadow {
        let shadow = NSShadow()
        let exposure = 1 - backdrop
        shadow.shadowColor = NSColor.black.withAlphaComponent(0.45 + 0.5 * exposure)
        shadow.shadowBlurRadius = 3 + max(2, size * 0.12) * exposure
        shadow.shadowOffset = NSSize(width: 0, height: -1)
        return shadow
    }

    private static var lineHeightCache: [String: CGFloat] = [:]

    /// Line height per point of font size, measured once per language.
    static func lineHeightPerPoint(lang: String, secondary: Bool) -> CGFloat {
        let key = "\(lang.prefix(2))-\(secondary)"
        if let cached = lineHeightCache[key] { return cached }
        let attributes = secondary
            ? secondaryAttributes(lang: lang, primarySize: 100 / secondaryRatio)
            : primaryAttributes(lang: lang, size: 100)
        let value = OverlayTextFitter.lineHeight(attributes) / 100
        lineHeightCache[key] = value
        return value
    }

    /// The primary font size that fills `height` with `lines` lines (plus the original's line).
    static func primarySize(forHeight height: CGFloat, lines: Int, showSecondary: Bool, primaryLang: String, secondaryLang: String) -> CGFloat {
        let content = height - verticalInset * 2 - (showSecondary ? spacing : 0)
        let perPoint = CGFloat(lines) * lineHeightPerPoint(lang: primaryLang, secondary: false)
            + (showSecondary ? lineHeightPerPoint(lang: secondaryLang, secondary: true) * secondaryRatio : 0)
        return min(maximumPrimarySize, max(minimumPrimarySize, (content / perPoint).rounded(.down)))
    }

    /// The window height that shows `lines` lines at `size`.
    static func height(forPrimarySize size: CGFloat, lines: Int, showSecondary: Bool, primaryLang: String = "zh", secondaryLang: String = "ko") -> CGFloat {
        let perPoint = CGFloat(lines) * lineHeightPerPoint(lang: primaryLang, secondary: false)
            + (showSecondary ? lineHeightPerPoint(lang: secondaryLang, secondary: true) * secondaryRatio : 0)
        return (verticalInset * 2 + (showSecondary ? spacing : 0) + size * perPoint).rounded(.up)
    }
}

/// Draws the fitted caption text; measuring and drawing use the same text engine. The font size comes
/// from the view's height, so resizing the window scales the text.
final class CaptionTextView: NSView {
    var primary: OverlayLine? { didSet { needsDisplay = true } }
    var secondary: OverlayLine? { didSet { needsDisplay = true } }
    var lines = 2 { didSet { needsDisplay = true } }
    var showSecondary = true { didSet { needsDisplay = true } }
    var backdrop: CGFloat = 1 { didSet { needsDisplay = true } }

    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    /// Primary font size for the current height (the window insets are already outside this view).
    var primarySize: CGFloat {
        OverlayStyle.primarySize(
            forHeight: bounds.height + OverlayStyle.verticalInset * 2,
            lines: lines,
            showSecondary: showSecondary,
            primaryLang: primary?.lang ?? "zh",
            secondaryLang: secondary?.lang ?? "ko"
        )
    }

    override func draw(_ dirtyRect: NSRect) {
        let width = bounds.width
        let size = primarySize
        var blocks: [(NSAttributedString, CGFloat)] = []
        if let primary, !primary.isEmpty {
            let attributes = OverlayStyle.primaryAttributes(lang: primary.lang, size: size, backdrop: backdrop)
            let text = OverlayTextFitter.fit(primary.sentences, cjk: primary.cjk, attributes: attributes, width: width, maxLines: lines)
            blocks.append((NSAttributedString(string: text, attributes: attributes), OverlayTextFitter.height(text, attributes, width)))
        }
        if showSecondary, let secondary, !secondary.isEmpty {
            let attributes = OverlayStyle.secondaryAttributes(lang: secondary.lang, primarySize: size, backdrop: backdrop)
            let text = OverlayTextFitter.fit(secondary.sentences, cjk: secondary.cjk, attributes: attributes, width: width, maxLines: 1)
            blocks.append((NSAttributedString(string: text, attributes: attributes), OverlayTextFitter.lineHeight(attributes)))
        }
        if blocks.isEmpty {
            let attributes = OverlayStyle.primaryAttributes(lang: "zh", size: size, backdrop: backdrop, placeholder: true)
            let text = "等待聲音…"
            blocks.append((NSAttributedString(string: text, attributes: attributes), OverlayTextFitter.height(text, attributes, width)))
        }
        let total = blocks.reduce(0) { $0 + $1.1 } + OverlayStyle.spacing * CGFloat(blocks.count - 1)
        var y = max(0, ((bounds.height - total) / 2).rounded())
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

/// Transparent root: lets the window be dragged from anywhere and reports hover.
final class OverlayRootView: NSView {
    var onHover: ((Bool) -> Void)?
    var onResize: (() -> Void)?
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

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        onResize?()
    }
}

/// Corner grip for resizing (borderless windows have no visible resize affordance).
final class ResizeGrip: NSView {
    private var startFrame = NSRect.zero
    private var startPoint = NSPoint.zero

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .crosshair)
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.white.withAlphaComponent(0.7).setStroke()
        for offset in stride(from: CGFloat(4), through: 12, by: 4) {
            let path = NSBezierPath()
            path.move(to: NSPoint(x: bounds.maxX - offset, y: 2))
            path.line(to: NSPoint(x: bounds.maxX - 2, y: offset))
            path.lineWidth = 1.5
            path.lineCapStyle = .round
            path.stroke()
        }
    }

    override func mouseDown(with event: NSEvent) {
        guard let window else { return }
        startFrame = window.frame
        startPoint = NSEvent.mouseLocation
    }

    // Dragging the bottom-right corner keeps the top-left corner in place.
    override func mouseDragged(with event: NSEvent) {
        guard let window else { return }
        let point = NSEvent.mouseLocation
        let minSize = window.minSize
        let width = max(minSize.width, startFrame.width + (point.x - startPoint.x))
        let height = max(minSize.height, startFrame.height - (point.y - startPoint.y))
        window.setFrame(NSRect(x: startFrame.minX, y: startFrame.maxY - height, width: width, height: height), display: true)
    }
}

final class OverlayButton: NSButton {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class OverlaySlider: NSSlider {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

@MainActor
final class CaptionOverlay: NSObject {
    struct State: Equatable {
        var visible = false
        var locked = false
        var opacity: Double = 0.85
        var lines = 2
        var showOriginal = true

        var json: [String: Any] {
            ["visible": visible, "locked": locked, "opacity": opacity, "lines": lines, "showOriginal": showOriginal]
        }
    }

    var onStateChange: ((State) -> Void)?
    private(set) var state: State
    private var panel: OverlayPanel?
    private let root = OverlayRootView()
    private let backdropView = NSVisualEffectView()
    private let textView = CaptionTextView()
    private let controls = NSStackView()
    private let grip = ResizeGrip()
    private let opacitySlider = OverlaySlider()
    private var lockButton: OverlayButton?
    private let defaults = UserDefaults.standard

    override init() {
        let defaults = UserDefaults.standard
        state = State(
            visible: false,
            locked: defaults.bool(forKey: "overlay.locked"),
            opacity: defaults.object(forKey: "overlay.opacity") as? Double ?? 0.85,
            lines: min(3, max(1, defaults.object(forKey: "overlay.lines") as? Int ?? 2)),
            showOriginal: defaults.object(forKey: "overlay.showOriginal") as? Bool ?? true
        )
        super.init()
    }

    /// Applies any subset of settings; `sizeStep` grows (+1) or shrinks (−1) the window, `resetFrame`
    /// puts it back at the bottom centre of the screen.
    func apply(
        visible: Bool? = nil,
        locked: Bool? = nil,
        opacity: Double? = nil,
        lines: Int? = nil,
        showOriginal: Bool? = nil,
        sizeStep: Int? = nil,
        resetFrame: Bool = false
    ) {
        var next = state
        if let visible { next.visible = visible }
        if let locked { next.locked = locked }
        if let opacity { next.opacity = min(1, max(0, (opacity * 100).rounded() / 100)) }
        if let lines { next.lines = min(3, max(1, lines)) }
        if let showOriginal { next.showOriginal = showOriginal }
        let layoutChanged = next.lines != state.lines || next.showOriginal != state.showOriginal
        let currentSize = textView.primarySize
        let changed = next != state
        state = next
        defaults.set(state.locked, forKey: "overlay.locked")
        defaults.set(state.opacity, forKey: "overlay.opacity")
        defaults.set(state.lines, forKey: "overlay.lines")
        defaults.set(state.showOriginal, forKey: "overlay.showOriginal")

        if state.visible {
            let panel = panel ?? makePanel()
            applyAppearance()
            if layoutChanged { setHeight(forPrimarySize: currentSize) }
            if let sizeStep { setHeight(forPrimarySize: currentSize * (sizeStep > 0 ? 1.12 : 1 / 1.12)) }
            if resetFrame { panel.setFrame(defaultFrame(), display: true, animate: true) }
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
        if changed || sizeStep != nil || resetFrame { onStateChange?(state) }
    }

    func update(primary: OverlayLine?, secondary: OverlayLine?) {
        if textView.primary != primary { textView.primary = primary }
        if textView.secondary != secondary { textView.secondary = secondary }
    }

    // ---- window -------------------------------------------------------------------------------

    private func defaultFrame() -> NSRect {
        let visible = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let width = min(visible.width * 0.62, 1080)
        let height = OverlayStyle.height(forPrimarySize: OverlayStyle.defaultPrimarySize, lines: state.lines, showSecondary: state.showOriginal)
        return NSRect(x: visible.midX - width / 2, y: visible.minY + 56, width: width, height: height)
    }

    private func makePanel() -> OverlayPanel {
        let panel = OverlayPanel(contentRect: defaultFrame(), styleMask: [.borderless, .nonactivatingPanel, .resizable], backing: .buffered, defer: false)
        panel.isFloatingPanel = true
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.hidesOnDeactivate = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.isMovableByWindowBackground = true
        panel.isReleasedWhenClosed = false
        panel.minSize = NSSize(width: 280, height: 44)
        panel.animationBehavior = .utilityWindow
        panel.setFrameUsingName("CaptionOverlay")
        panel.setFrameAutosaveName("CaptionOverlay")

        root.onHover = { [weak self] hovering in self?.setControlsVisible(hovering) }
        root.onResize = { [weak self] in self?.textView.needsDisplay = true }
        panel.contentView = root

        // The frosted background is a sibling of the text, so its opacity never fades the text.
        backdropView.material = .hudWindow
        backdropView.blendingMode = .behindWindow
        backdropView.state = .active
        backdropView.appearance = NSAppearance(named: .vibrantDark)
        backdropView.maskImage = Self.roundedMask(radius: 18)
        pin(backdropView, in: root, inset: NSEdgeInsets(top: 0, left: 0, bottom: 0, right: 0))

        textView.lines = state.lines
        textView.showSecondary = state.showOriginal
        pin(textView, in: root, inset: NSEdgeInsets(
            top: OverlayStyle.verticalInset, left: OverlayStyle.horizontalInset,
            bottom: OverlayStyle.verticalInset, right: OverlayStyle.horizontalInset
        ))
        buildControls(in: root)

        grip.translatesAutoresizingMaskIntoConstraints = false
        grip.alphaValue = 0
        grip.toolTip = "拖曳調整大小"
        root.addSubview(grip)
        NSLayoutConstraint.activate([
            grip.widthAnchor.constraint(equalToConstant: 18),
            grip.heightAnchor.constraint(equalToConstant: 18),
            grip.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -4),
            grip.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -4),
        ])

        self.panel = panel
        return panel
    }

    private func applyAppearance() {
        panel?.ignoresMouseEvents = state.locked
        backdropView.alphaValue = CGFloat(state.opacity)
        panel?.hasShadow = state.opacity > 0.15
        textView.backdrop = CGFloat(state.opacity)
        textView.lines = state.lines
        textView.showSecondary = state.showOriginal
        if opacitySlider.doubleValue != state.opacity { opacitySlider.doubleValue = state.opacity }
        let symbol = state.locked ? "lock" : "lock.open"
        lockButton?.image = NSImage(systemSymbolName: symbol, accessibilityDescription: "鎖定")?
            .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 12, weight: .semibold))
    }

    /// Resizes the height so the text is `size` points, keeping the bottom edge and staying on screen.
    private func setHeight(forPrimarySize size: CGFloat) {
        guard let panel else { return }
        let clamped = min(OverlayStyle.maximumPrimarySize, max(OverlayStyle.minimumPrimarySize, size))
        var frame = panel.frame
        let limit = (panel.screen?.visibleFrame.height ?? 900) * 0.8
        frame.size.height = min(limit, OverlayStyle.height(
            forPrimarySize: clamped, lines: state.lines, showSecondary: state.showOriginal,
            primaryLang: textView.primary?.lang ?? "zh", secondaryLang: textView.secondary?.lang ?? "ko"
        ))
        panel.setFrame(frame, display: true, animate: true)
    }

    private func pin(_ view: NSView, in container: NSView, inset: NSEdgeInsets) {
        view.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(view)
        NSLayoutConstraint.activate([
            view.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: inset.left),
            view.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -inset.right),
            view.topAnchor.constraint(equalTo: container.topAnchor, constant: inset.top),
            view.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -inset.bottom),
        ])
    }

    private func buildControls(in container: NSView) {
        let configuration = NSImage.SymbolConfiguration(pointSize: 12, weight: .semibold)
        func button(_ symbol: String, _ tooltip: String, _ action: Selector) -> OverlayButton {
            let button = OverlayButton()
            button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: tooltip)?.withSymbolConfiguration(configuration)
            button.isBordered = false
            button.contentTintColor = NSColor.white.withAlphaComponent(0.9)
            button.toolTip = tooltip
            button.target = self
            button.action = action
            button.translatesAutoresizingMaskIntoConstraints = false
            button.widthAnchor.constraint(equalToConstant: 26).isActive = true
            button.heightAnchor.constraint(equalToConstant: 22).isActive = true
            return button
        }

        let opacityIcon = NSImageView(image: NSImage(systemSymbolName: "circle.lefthalf.filled", accessibilityDescription: "背景透明度")!
            .withSymbolConfiguration(configuration)!)
        opacityIcon.contentTintColor = NSColor.white.withAlphaComponent(0.75)
        opacityIcon.toolTip = "背景透明度"
        opacitySlider.minValue = 0
        opacitySlider.maxValue = 1
        opacitySlider.doubleValue = state.opacity
        opacitySlider.controlSize = .small
        opacitySlider.isContinuous = true
        opacitySlider.target = self
        opacitySlider.action = #selector(opacityChanged)
        opacitySlider.toolTip = "背景透明度"
        opacitySlider.translatesAutoresizingMaskIntoConstraints = false
        opacitySlider.widthAnchor.constraint(equalToConstant: 84).isActive = true

        let lock = button("lock.open", "鎖定（滑鼠穿透，不擋影片操作）", #selector(toggleLock))
        lockButton = lock
        for view in [
            button("textformat.size.smaller", "縮小", #selector(smaller)),
            button("textformat.size.larger", "放大", #selector(larger)),
            opacityIcon,
            opacitySlider,
            lock,
            button("xmark", "關閉懸浮字幕", #selector(close)),
        ] {
            controls.addArrangedSubview(view)
        }
        controls.setCustomSpacing(8, after: controls.arrangedSubviews[1])
        controls.setCustomSpacing(8, after: opacitySlider)
        controls.orientation = .horizontal
        controls.spacing = 2
        controls.edgeInsets = NSEdgeInsets(top: 2, left: 8, bottom: 2, right: 6)
        controls.wantsLayer = true
        controls.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.5).cgColor
        controls.layer?.cornerRadius = 10
        controls.alphaValue = 0
        controls.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(controls)
        NSLayoutConstraint.activate([
            controls.topAnchor.constraint(equalTo: container.topAnchor, constant: 8),
            controls.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -10),
        ])
    }

    private func setControlsVisible(_ visible: Bool) {
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.15
            controls.animator().alphaValue = visible ? 1 : 0
            grip.animator().alphaValue = visible ? 1 : 0
        }
    }

    @objc private func smaller() { apply(sizeStep: -1) }
    @objc private func larger() { apply(sizeStep: 1) }
    @objc private func toggleLock() { apply(locked: !state.locked) }
    @objc private func close() { apply(visible: false) }
    @objc private func opacityChanged() { apply(opacity: opacitySlider.doubleValue) }

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
