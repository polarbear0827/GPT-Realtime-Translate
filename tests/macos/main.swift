// End-to-end check of the macOS host without showing UI: serves public/ with StaticServer, loads it
// in an offscreen WKWebView wired to NativeBridge, then exercises the bridge and the HTTP server.
// Run: npm run test:macos
import AppKit
import Network
import WebKit

@MainActor
final class Harness: NSObject, BridgeHost, WKNavigationDelegate {
    private var server: StaticServer!
    private var webView: WKWebView!
    private var window: NSWindow!
    private var bridge: NativeBridge!
    private var failures = 0
    private var started = false
    private var savedContent = ""
    private var leaveGuardCalls = 0

    func run(publicDir: URL) {
        let config = try! RealtimeConfig.load(from: publicDir.appendingPathComponent("realtime-config.json"))
        let backend = RealtimeBackend(config: config, version: "0.0.0-test")
        bridge = NativeBridge(backend: backend, version: "0.0.0-test")
        bridge.host = self
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "klt")
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1280, height: 800), configuration: configuration)
        webView.navigationDelegate = self
        window = NSWindow(contentRect: NSRect(x: -5000, y: -5000, width: 1280, height: 800), styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = webView
        window.orderFront(nil)
        server = StaticServer(root: publicDir)
        server.start(preferredPort: 0) { [weak self] result in
            guard let self else { return }
            guard case .success(let port) = result else {
                print("FAIL server start \(result)")
                exit(1)
            }
            self.webView.load(URLRequest(url: URL(string: "http://127.0.0.1:\(port)/")!))
        }
    }

    // ---- BridgeHost ----
    func isTrustedFrame(_ frame: WKFrameInfo) -> Bool {
        let origin = frame.securityOrigin
        return frame.isMainFrame && origin.protocol == "http" && origin.host == "127.0.0.1" && origin.port == Int(server.port)
    }

    func saveFile(name: String, content: String, completion: @escaping ([String: Any]) -> Void) {
        savedContent = content
        completion(["saved": true, "path": "/tmp/\(name)"])
    }

    func setFullscreen(_ enabled: Bool) -> Bool { enabled }
    func setKeepAwake(_ enabled: Bool) {}
    func setLeaveGuard(enabled: Bool, message: String) { leaveGuardCalls += 1 }
    func openDisplayWindow() {}

    // ---- checks ----
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard !started else { return }
        started = true
        Task { await self.runChecks() }
    }

    private func check(_ name: String, _ ok: Bool, _ detail: String = "") {
        print("\(ok ? "PASS" : "FAIL") \(name)\(detail.isEmpty ? "" : " — \(detail)")")
        if !ok { failures += 1 }
    }

    private func runChecks() async {
        var label = ""
        for _ in 0..<100 {
            label = (try? await webView.evaluateJavaScript("document.getElementById('versionLabel').textContent")) as? String ?? ""
            if !label.isEmpty { break }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        check("page boots and reads health through the bridge", label == "版本 0.0.0-test", label)

        let script = """
        const h = window.webkit.messageHandlers.klt;
        const call = async (message) => JSON.parse(await h.postMessage(message));
        return JSON.stringify({
          info: await call({ action: "info" }),
          health: await call({ action: "request", method: "GET", path: "/api/health" }),
          badLanguage: await call({ action: "request", method: "POST", path: "/api/realtime/transcription-client-secret", body: { sourceLanguage: "xx" } }),
          badKeywords: await call({ action: "request", method: "POST", path: "/api/realtime/transcription-client-secret", body: { keywords: ["x".repeat(61)] } }),
          noKey: await call({ action: "request", method: "POST", path: "/api/realtime/translation-client-secret", body: { targetLanguage: "zh" } }),
          badKey: await call({ action: "request", method: "POST", path: "/api/key", body: { apiKey: "nope" } }),
          save: await call({ action: "saveFile", filename: "a.srt", mimeType: "text/plain", content: "1\\n00:00:00,000 --> 00:00:01,000\\n測試" }),
          startButton: document.getElementById("startStopBtn").textContent,
          keyDialogOpen: document.getElementById("keyDialog").open,
        });
        """
        do {
            let raw = try await webView.callAsyncJavaScript(script, contentWorld: .page) as? String ?? "{}"
            let result = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any] ?? [:]
            let info = result["info"] as? [String: Any]
            check("info reports macOS + Keychain support", info?["platform"] as? String == "macos"
                && (info?["supports"] as? [String: Any])?["rememberKey"] as? Bool == true)
            let health = result["health"] as? [String: Any]
            check("health via bridge", health?["status"] as? Int == 200, "\(health ?? [:])")
            check("unsupported language → 400", (result["badLanguage"] as? [String: Any])?["status"] as? Int == 400)
            check("over-long keyword → 400", (result["badKeywords"] as? [String: Any])?["status"] as? Int == 400)
            check("client secret without key → 401", (result["noKey"] as? [String: Any])?["status"] as? Int == 401)
            check("malformed key → 400", (result["badKey"] as? [String: Any])?["status"] as? Int == 400)
            check("saveFile round trip", (result["save"] as? [String: Any])?["saved"] as? Bool == true && savedContent.contains("測試"))
            check("UI rendered in Chinese", result["startButton"] as? String == "開始")
            check("key dialog opens when no key is stored", result["keyDialogOpen"] as? Bool == true)
            check("leave guard reported to native", leaveGuardCalls > 0)
        } catch {
            check("bridge script", false, "\(error)")
        }

        let port = server.port
        check("index served", await rawStatus("GET / HTTP/1.1\r\nHost: 127.0.0.1:\(port)\r\n\r\n") == 200)
        check("worklet module served", await rawStatus("GET /js/pcm-worklet.js HTTP/1.1\r\nHost: 127.0.0.1:\(port)\r\n\r\n") == 200)
        check("foreign Host rejected (DNS rebinding)", await rawStatus("GET / HTTP/1.1\r\nHost: attacker.example:\(port)\r\n\r\n") == 403)
        check("missing file → 404", await rawStatus("GET /favicon.ico HTTP/1.1\r\nHost: 127.0.0.1:\(port)\r\n\r\n") == 404)
        check("path traversal blocked", await rawStatus("GET /%2e%2e/%2e%2e/etc/passwd HTTP/1.1\r\nHost: 127.0.0.1:\(port)\r\n\r\n") == 404)
        check("POST rejected", await rawStatus("POST /api/key HTTP/1.1\r\nHost: 127.0.0.1:\(port)\r\nContent-Length: 0\r\n\r\n") == 405)

        print(failures == 0 ? "ALL PASSED" : "\(failures) FAILED")
        exit(failures == 0 ? 0 : 1)
    }

    private func rawStatus(_ request: String) async -> Int {
        await withCheckedContinuation { continuation in
            let connection = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: server.port)!, using: .tcp)
            var resumed = false
            let finish: (Int) -> Void = { status in
                guard !resumed else { return }
                resumed = true
                connection.cancel()
                continuation.resume(returning: status)
            }
            connection.stateUpdateHandler = { state in
                if case .failed = state { finish(-1) }
            }
            connection.start(queue: .main)
            connection.send(content: Data(request.utf8), completion: .contentProcessed { _ in })
            connection.receive(minimumIncompleteLength: 12, maximumLength: 65_536) { data, _, _, _ in
                let text = data.map { String(decoding: $0, as: UTF8.self) } ?? ""
                let parts = text.split(separator: " ")
                finish(parts.count > 1 ? Int(parts[1]) ?? -1 : -1)
            }
        }
    }
}

let publicDir = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? "public").standardizedFileURL
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let harness = MainActor.assumeIsolated { Harness() }
MainActor.assumeIsolated { harness.run(publicDir: publicDir) }
DispatchQueue.main.asyncAfter(deadline: .now() + 30) {
    print("FAIL timeout")
    exit(1)
}
app.run()
