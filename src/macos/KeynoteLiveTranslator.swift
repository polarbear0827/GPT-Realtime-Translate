import AppKit
import WebKit

final class KeynoteLiveTranslatorApp: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var serverProcess: Process?
    private var logHandle: FileHandle?
    private let port = ProcessInfo.processInfo.environment["KEYNOTE_TRANSLATOR_PORT"] ?? "8787"

    private var appURL: URL {
        URL(string: "http://127.0.0.1:\(port)/")!
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        createWindow()
        startServerIfNeeded()
        waitForServerAndLoad()
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationWillTerminate(_ notification: Notification) {
        stopServer()
    }

    private func createWindow() {
        let config = WKWebViewConfiguration()
        config.mediaTypesRequiringUserActionForPlayback = []
        if #available(macOS 10.15, *) {
            config.defaultWebpagePreferences.allowsContentJavaScript = true
        }

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Keynote Live Translator"
        window.minSize = NSSize(width: 860, height: 560)
        window.contentView = webView
        window.delegate = self
        window.center()
        window.makeKeyAndOrderFront(nil)
    }

    private func startServerIfNeeded() {
        if serverIsHealthy() {
            return
        }

        guard let resourceURL = Bundle.main.resourceURL else {
            showStartupError("找不到 App resources。")
            return
        }

        let nodeURL = resourceURL.appendingPathComponent("node/bin/node")
        let serverURL = resourceURL.appendingPathComponent("server/index.mjs")

        let process = Process()
        process.executableURL = nodeURL
        process.arguments = [serverURL.path]
        process.environment = [
            "PORT": port,
            "APP_VERSION": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.2.0",
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"
        ]

        configureLogging(for: process)

        do {
            try process.run()
            serverProcess = process
        } catch {
            showStartupError("本機 server 啟動失敗：\(error.localizedDescription)")
        }
    }

    private func configureLogging(for process: Process) {
        let fileManager = FileManager.default
        guard let library = fileManager.urls(for: .libraryDirectory, in: .userDomainMask).first else {
            return
        }
        let logDirectory = library.appendingPathComponent("Logs/KeynoteLiveTranslator", isDirectory: true)
        let logURL = logDirectory.appendingPathComponent("server.log")
        do {
            try fileManager.createDirectory(at: logDirectory, withIntermediateDirectories: true)
            if !fileManager.fileExists(atPath: logURL.path) {
                fileManager.createFile(atPath: logURL.path, contents: nil)
            }
            let handle = try FileHandle(forWritingTo: logURL)
            try handle.seekToEnd()
            process.standardOutput = handle
            process.standardError = handle
            logHandle = handle
        } catch {
            process.standardOutput = Pipe()
            process.standardError = Pipe()
        }
    }

    private func waitForServerAndLoad() {
        DispatchQueue.global(qos: .userInitiated).async {
            for _ in 0..<80 {
                if self.serverIsHealthy() {
                    DispatchQueue.main.async {
                        self.webView.load(URLRequest(url: self.appURL))
                    }
                    return
                }
                Thread.sleep(forTimeInterval: 0.25)
            }

            DispatchQueue.main.async {
                self.showStartupError("本機 server 無法啟動，請查看 ~/Library/Logs/KeynoteLiveTranslator/server.log。")
            }
        }
    }

    private func serverIsHealthy() -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(port)/api/health") else {
            return false
        }

        var request = URLRequest(url: url)
        request.timeoutInterval = 0.5

        let semaphore = DispatchSemaphore(value: 0)
        var healthy = false
        URLSession.shared.dataTask(with: request) { _, response, _ in
            if let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 {
                healthy = true
            }
            semaphore.signal()
        }.resume()

        _ = semaphore.wait(timeout: .now() + 0.8)
        return healthy
    }

    private func stopServer() {
        if let process = serverProcess, process.isRunning {
            process.terminate()
        }
        try? logHandle?.close()
    }

    private func showStartupError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "Keynote Live Translator 啟動失敗"
        alert.informativeText = message
        alert.alertStyle = .critical
        alert.runModal()
    }

    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        decisionHandler(.grant)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showStartupError("頁面載入失敗：\(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showStartupError("頁面載入失敗：\(error.localizedDescription)")
    }
}

let app = NSApplication.shared
let delegate = KeynoteLiveTranslatorApp()
app.delegate = delegate
app.run()
