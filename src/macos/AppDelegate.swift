import AppKit
import UniformTypeIdentifiers
import WebKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, BridgeHost {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var displayWindow: NSWindow?
    private var server: StaticServer!
    private var bridge: NativeBridge!
    private var activity: NSObjectProtocol?
    private var quitConfirmed = false
    var leaveGuard: (enabled: Bool, message: String) = (false, "")

    private let preferredPort: UInt16 = UInt16(ProcessInfo.processInfo.environment["KEYNOTE_TRANSLATOR_PORT"] ?? "") ?? 8787
    private let background = NSColor(red: 0x11 / 255, green: 0x13 / 255, blue: 0x11 / 255, alpha: 1)

    private var version: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        buildMainMenu()
        guard let publicURL = Bundle.main.resourceURL?.appendingPathComponent("public"),
              let config = try? RealtimeConfig.load(from: publicURL.appendingPathComponent("realtime-config.json"))
        else {
            showFatalError("找不到 App 內的網頁資源，請重新安裝。")
            return
        }
        let backend = RealtimeBackend(config: config, version: version)
        bridge = NativeBridge(backend: backend, version: version)
        bridge.host = self
        createMainWindow()
        NSApp.activate(ignoringOtherApps: true)

        server = StaticServer(root: publicURL)
        server.start(preferredPort: preferredPort) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let port):
                self.webView.load(URLRequest(url: URL(string: "http://127.0.0.1:\(port)/")!))
            case .failure(let error):
                self.showFatalError("無法啟動本機頁面服務：\(error.localizedDescription)")
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if quitConfirmed || !leaveGuard.enabled { return .terminateNow }
        if confirmLeave() {
            quitConfirmed = true
            return .terminateNow
        }
        return .terminateCancel
    }

    func applicationWillTerminate(_ notification: Notification) {
        setKeepAwake(false)
        server?.stop()
    }

    // ---- windows ------------------------------------------------------------------------------

    private func makeWebView(withBridge: Bool) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.mediaTypesRequiringUserActionForPlayback = []
        if withBridge {
            configuration.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "klt")
        }
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = self
        view.uiDelegate = self
        view.setValue(false, forKey: "drawsBackground")
        return view
    }

    private func createMainWindow() {
        webView = makeWebView(withBridge: true)
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Keynote Live Translator"
        window.minSize = NSSize(width: 860, height: 560)
        window.backgroundColor = background
        window.contentView = webView
        window.delegate = self
        window.collectionBehavior.insert(.fullScreenPrimary)
        window.center()
        window.setFrameAutosaveName("MainWindow")
        window.makeKeyAndOrderFront(nil)
    }

    func openDisplayWindow() {
        if let displayWindow {
            displayWindow.makeKeyAndOrderFront(nil)
            return
        }
        let view = makeWebView(withBridge: false)
        // Prefer a second screen (projector) when one is connected.
        let target = NSScreen.screens.first { $0 != window.screen } ?? window.screen ?? NSScreen.main
        let frame = target?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1280, height: 720)
        let size = NSSize(width: min(1280, frame.width), height: min(720, frame.height))
        let displayWindow = NSWindow(
            contentRect: NSRect(origin: NSPoint(x: frame.midX - size.width / 2, y: frame.midY - size.height / 2), size: size),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        displayWindow.title = "字幕視窗"
        displayWindow.backgroundColor = .black
        displayWindow.isReleasedWhenClosed = false
        displayWindow.contentView = view
        displayWindow.delegate = self
        displayWindow.collectionBehavior.insert(.fullScreenPrimary)
        displayWindow.makeKeyAndOrderFront(nil)
        view.load(URLRequest(url: URL(string: "http://127.0.0.1:\(server.port)/?view=display")!))
        self.displayWindow = displayWindow
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard sender == window, leaveGuard.enabled, !quitConfirmed else { return true }
        if confirmLeave() {
            quitConfirmed = true
            return true
        }
        return false
    }

    func windowWillClose(_ notification: Notification) {
        guard let closing = notification.object as? NSWindow else { return }
        if closing == displayWindow {
            displayWindow = nil
        } else if closing == window {
            quitConfirmed = true
            NSApp.terminate(nil)
        }
    }

    private func confirmLeave() -> Bool {
        let alert = NSAlert()
        alert.messageText = leaveGuard.message.isEmpty ? "確定要結束嗎？" : leaveGuard.message
        alert.informativeText = "關閉後，尚未匯出的逐字稿可能會遺失。"
        alert.alertStyle = .warning
        alert.addButton(withTitle: "取消")
        alert.addButton(withTitle: "仍要結束")
        return alert.runModal() == .alertSecondButtonReturn
    }

    // ---- bridge actions -----------------------------------------------------------------------

    func isTrustedFrame(_ frame: WKFrameInfo) -> Bool {
        let origin = frame.securityOrigin
        return frame.isMainFrame && origin.protocol == "http" && origin.host == "127.0.0.1" && origin.port == Int(server.port)
    }

    func saveFile(name: String, content: String, completion: @escaping ([String: Any]) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = (name as NSString).lastPathComponent
        panel.canCreateDirectories = true
        let pathExtension = (name as NSString).pathExtension
        if let type = UTType(filenameExtension: pathExtension) {
            panel.allowedContentTypes = [type]
        }
        panel.beginSheetModal(for: window) { response in
            guard response == .OK, let url = panel.url else {
                completion(["saved": false, "cancelled": true])
                return
            }
            do {
                try Data(content.utf8).write(to: url, options: .atomic)
                completion(["saved": true, "path": url.path])
            } catch {
                completion(["saved": false, "error": error.localizedDescription])
            }
        }
    }

    func setLeaveGuard(enabled: Bool, message: String) {
        leaveGuard = (enabled, message)
    }

    func setFullscreen(_ enabled: Bool) -> Bool {
        if window.styleMask.contains(.fullScreen) != enabled {
            window.toggleFullScreen(nil)
        }
        return enabled
    }

    // Keeps the display awake and prevents App Nap while captions are live.
    func setKeepAwake(_ enabled: Bool) {
        if enabled, activity == nil {
            activity = ProcessInfo.processInfo.beginActivity(
                options: [.userInitiated, .idleDisplaySleepDisabled],
                reason: "Live captions are running"
            )
        } else if !enabled, let activity {
            ProcessInfo.processInfo.endActivity(activity)
            self.activity = nil
        }
    }

    // ---- WebKit delegates ---------------------------------------------------------------------

    private func isAppURL(_ url: URL?) -> Bool {
        guard let url else { return false }
        return url.scheme == "http" && url.host == "127.0.0.1" && url.port == Int(server?.port ?? 0)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        let url = navigationAction.request.url
        if isAppURL(url) || url?.absoluteString == "about:blank" {
            decisionHandler(.allow)
            return
        }
        // External links open in the default browser instead of replacing the app UI.
        if let url, navigationAction.navigationType == .linkActivated, url.scheme == "https" {
            NSWorkspace.shared.open(url)
        }
        decisionHandler(.cancel)
    }

    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        let trusted = origin.protocol == "http" && origin.host == "127.0.0.1" && origin.port == Int(server.port)
        decisionHandler(trusted && type == .microphone ? .grant : .deny)
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = message
        alert.runModal()
        completionHandler()
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "確定")
        alert.addButton(withTitle: "取消")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // The page offers to restore the auto-backed-up transcript after reloading.
        webView.reload()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        showFatalError("頁面載入失敗：\(error.localizedDescription)")
    }

    // ---- menu & errors ------------------------------------------------------------------------

    private func buildMainMenu() {
        let mainMenu = NSMenu()

        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "關於 Keynote Live Translator", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隱藏 Keynote Live Translator", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "隱藏其他", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "顯示全部", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "結束 Keynote Live Translator", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        addSubmenu(appMenu, to: mainMenu)

        // Without an Edit menu AppKit never routes ⌘C / ⌘V / ⌘A to the web view.
        let editMenu = NSMenu(title: "編輯")
        editMenu.addItem(withTitle: "還原", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "剪下", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "拷貝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "貼上", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全選", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        addSubmenu(editMenu, to: mainMenu)

        let viewMenu = NSMenu(title: "顯示方式")
        let fullScreen = viewMenu.addItem(withTitle: "切換全螢幕", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fullScreen.keyEquivalentModifierMask = [.command, .control]
        addSubmenu(viewMenu, to: mainMenu)

        let windowMenu = NSMenu(title: "視窗")
        windowMenu.addItem(withTitle: "縮到最小", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "縮放", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowMenu.addItem(withTitle: "關閉視窗", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        addSubmenu(windowMenu, to: mainMenu)
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = mainMenu
    }

    private func addSubmenu(_ submenu: NSMenu, to menu: NSMenu) {
        let item = NSMenuItem()
        item.submenu = submenu
        menu.addItem(item)
    }

    private func showFatalError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "Keynote Live Translator 無法啟動"
        alert.informativeText = message
        alert.alertStyle = .critical
        alert.runModal()
    }
}
