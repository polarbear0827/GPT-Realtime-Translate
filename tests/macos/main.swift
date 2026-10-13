// End-to-end check of the macOS host without showing UI: serves public/ with StaticServer, loads it
// in an offscreen WKWebView wired to NativeBridge, then exercises the bridge and the HTTP server.
// Run: npm run test:macos
import AppKit
import AVFoundation
import Network
import Vision
import WebKit

// Never read or write the user's real Keychain item from tests.
final class MemoryKeyStore: KeyStoring {
    private var key: String?
    func load() -> String? { key }
    func save(_ key: String) -> Bool {
        self.key = key
        return true
    }
    func delete() { key = nil }
}

@MainActor
final class Harness: NSObject, BridgeHost, WKNavigationDelegate {
    private var server: StaticServer!
    var webView: WKWebView!
    private var window: NSWindow!
    private var bridge: NativeBridge!
    private var failures = 0
    private var started = false
    private var savedContent = ""
    private var leaveGuardCalls = 0
    private var appearance = ""
    private var systemAudioStarted = false
    private var overlay: [String: Any] = ["visible": false, "locked": false, "opacity": 0.85, "lines": 2, "showOriginal": true]
    private var overlayUpdates: [(OverlayLine?, OverlayLine?)] = []
    private var translationOpened: [String] = []
    private var translationAudio: [String: Bool] = [:]
    private var translationClosed: [String] = []
    private let relay = FakeRelay()
    private var pendingShareSetup: [String: String]?

    func run(publicDir: URL) {
        let config = try! RealtimeConfig.load(from: publicDir.appendingPathComponent("realtime-config.json"))
        let backend = RealtimeBackend(config: config, version: "0.0.0-test", keyStore: MemoryKeyStore(), relayStore: MemoryKeyStore())
        backend.onShareOriginChange = { [weak self] origin in self?.server.setRelayOrigin(origin) }
        relay.start()
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
    func setAppearance(_ theme: String) { appearance = theme }
    func takeShareSetup() -> [String: String]? {
        defer { pendingShareSetup = nil }
        return pendingShareSetup
    }

    // Translation socket is simulated: it "opens", then delivers one translated delta.
    func openTranslation(id: String, body: [String: Any], audioEnabled: Bool) async throws {
        guard body["targetLanguage"] as? String == "zh" else { throw BackendError(status: 400, message: "不支援的翻譯目標語言。") }
        translationOpened.append(id)
        let event = NativeBridge.json([id, "{\"type\":\"session.output_transcript.delta\",\"delta\":\"你好\"}"])
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(100)) { [weak self] in
            self?.webView.evaluateJavaScript("window.__kltTranslationEvent&&window.__kltTranslationEvent(...\(event))")
        }
    }
    func setTranslationAudio(id: String, enabled: Bool) { translationAudio[id] = enabled }
    func closeTranslation(id: String, graceful: Bool) async { translationClosed.append(id) }

    // System audio is simulated: 10 chunks of a 440 Hz tone, delivered the way the app delivers them.
    var systemAudioSupported: Bool { true }
    func startSystemAudio(muteSource: Bool) throws {
        systemAudioStarted = true
        for index in 0..<10 {
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(50 * index)) { [weak self] in
                guard let self, self.systemAudioStarted else { return }
                let samples = (0..<1200).map { Int16(12000 * sin(Double($0 + index * 1200) * 2 * .pi * 440 / 24000)) }
                let data = samples.withUnsafeBufferPointer { Data(buffer: $0) }
                self.webView.evaluateJavaScript("window.__kltSystemAudio&&window.__kltSystemAudio('\(data.base64EncodedString())',0.25,0.37)")
            }
        }
    }
    func stopSystemAudio() { systemAudioStarted = false }
    var overlayState: [String: Any] { overlay }
    func configureOverlay(_ settings: [String: Any]) -> [String: Any] {
        for key in ["visible", "locked", "opacity", "lines", "showOriginal"] where settings[key] != nil {
            overlay[key] = settings[key]
        }
        return overlay
    }
    func updateOverlay(primary: OverlayLine?, secondary: OverlayLine?) {
        overlayUpdates.append((primary, secondary))
    }

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

        await checkSystemAudioAndOverlay()
        await checkSharing()
        await checkSetupLink()
        await checkQrCodes()
        checkTextFitting()
        checkResponsiveSizing()
        checkDownsampler()

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

    private func checkSystemAudioAndOverlay() async {
        let script = """
        const h = window.webkit.messageHandlers.klt;
        const call = async (message) => JSON.parse(await h.postMessage(message));
        const info = await call({ action: "info" });
        const overlay = await call({ action: "overlay", visible: true, opacity: 0.4, lines: 3 });
        await call({ action: "overlayUpdate", primary: { sentences: ["你好。", "今天天氣很好。"], cjk: true, lang: "zh-Hant" }, secondary: { sentences: ["안녕하세요."], cjk: false, lang: "ko" } });
        await call({ action: "setAppearance", theme: "light" });
        const { SystemAudioInput } = await import("/js/system-audio.js");
        let chunks = 0;
        let lastRms = 0;
        const input = new SystemAudioInput({ onChunk: (pcm, rms) => { chunks += pcm.byteLength === 2400 ? 1 : 0; lastRms = rms; } });
        await input.open({ muteSource: false });
        await new Promise((resolve) => setTimeout(resolve, 900));
        const track = input.track;
        const { NativeTranslateClient } = await import("/js/native-translate.js");
        const deltas = [];
        const translator = new NativeTranslateClient({ targetLanguage: "zh", onEvent: (event) => deltas.push(event) });
        await translator.connect(null, { audioEnabled: false });
        await translator.setAudioEnabled(true);
        await new Promise((resolve) => setTimeout(resolve, 300));
        await translator.close({ graceful: true });
        let rejected = "";
        try {
          await new NativeTranslateClient({ targetLanguage: "xx" }).connect(null);
        } catch (error) {
          rejected = error.message;
        }
        const result = { info, overlay, chunks, lastRms, trackKind: track?.kind, trackState: track?.readyState, contextRate: input.context?.sampleRate,
          supported: NativeTranslateClient.supported, deltas, translatorId: translator.id, rejected };
        input.close();
        return JSON.stringify(result);
        """
        do {
            let raw = try await webView.callAsyncJavaScript(script, contentWorld: .page) as? String ?? "{}"
            let result = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any] ?? [:]
            let supports = (result["info"] as? [String: Any])?["supports"] as? [String: Any]
            check("info reports system audio + overlay support", supports?["systemAudio"] as? Bool == true && supports?["overlay"] as? Bool == true)
            let overlay = result["overlay"] as? [String: Any]
            check("overlay settings round trip", overlay?["visible"] as? Bool == true && overlay?["opacity"] as? Double == 0.4 && overlay?["lines"] as? Int == 3)
            check("overlay text reaches native", overlayUpdates.last?.0?.sentences == ["你好。", "今天天氣很好。"] && overlayUpdates.last?.1?.lang == "ko")
            check("theme reaches native window", appearance == "light")
            check("system audio chunks reach the page pipeline", result["chunks"] as? Int == 10, "\(result["chunks"] ?? "nil") chunks")
            check("system audio becomes a live WebRTC-ready track", result["trackKind"] as? String == "audio" && result["trackState"] as? String == "live",
                  "rate \(result["contextRate"] ?? "nil")")
            check("stop releases native capture", !systemAudioStarted)
            let deltas = result["deltas"] as? [[String: Any]] ?? []
            let translatorId = result["translatorId"] as? String ?? ""
            check("native translation socket opens, streams events, closes",
                  result["supported"] as? Bool == true && deltas.first?["delta"] as? String == "你好"
                  && translationOpened.contains(translatorId) && translationAudio[translatorId] == true && translationClosed.contains(translatorId),
                  "\(deltas)")
            check("native translation errors reach the page", result["rejected"] as? String == "不支援的翻譯目標語言。", "\(result["rejected"] ?? "")")
        } catch {
            check("system audio / overlay script", false, "\(error)")
        }
    }

    private func checkTextFitting() {
        let attributes = OverlayStyle.primaryAttributes(lang: "zh-Hant", size: 30)
        let sentences = ["第一句話。", "第二句話比較長一點。", "最新的第三句。"]
        let wide = OverlayTextFitter.fit(sentences, cjk: true, attributes: attributes, width: 1000, maxLines: 2)
        check("fitter keeps every sentence that fits", wide == sentences.joined())
        let narrow = OverlayTextFitter.fit(sentences, cjk: true, attributes: attributes, width: 220, maxLines: 2)
        check("fitter drops the oldest sentences first", narrow.hasSuffix("最新的第三句。") && !narrow.hasPrefix("第一句"), narrow)
        let long = String(repeating: "很長的句子", count: 20) + "結尾。"
        let tail = OverlayTextFitter.fit([long], cjk: true, attributes: attributes, width: 300, maxLines: 2)
        check("an over-long sentence shows its end", tail.hasPrefix("…") && tail.hasSuffix("結尾。"), tail)
        check("fitted text really fits two lines",
              OverlayTextFitter.height(tail, attributes, 300) <= OverlayTextFitter.lineHeight(attributes) * 2 + 1)
        let english = OverlayTextFitter.fit(["Short.", "This is the newest sentence, it keeps going and going for a while."],
                                            cjk: false, attributes: OverlayStyle.primaryAttributes(lang: "en", size: 30), width: 260, maxLines: 2)
        check("latin text is cut at a word boundary", english.hasPrefix("…") ? !english.dropFirst().hasPrefix(" ") : true, english)
    }

    private func checkResponsiveSizing() {
        // Text size follows the window height, and the height for a size round-trips.
        let small = OverlayStyle.primarySize(forHeight: 100, lines: 2, showSecondary: true, primaryLang: "zh", secondaryLang: "ko")
        let large = OverlayStyle.primarySize(forHeight: 300, lines: 2, showSecondary: true, primaryLang: "zh", secondaryLang: "ko")
        check("taller window → larger text", large > small * 2.5, "\(small) → \(large)")
        let height = OverlayStyle.height(forPrimarySize: 40, lines: 3, showSecondary: false)
        let size = OverlayStyle.primarySize(forHeight: height, lines: 3, showSecondary: false, primaryLang: "zh", secondaryLang: "ko")
        check("height ↔ size round trip", abs(size - 40) <= 1, "\(size)")
        check("size is clamped", OverlayStyle.primarySize(forHeight: 20, lines: 3, showSecondary: true, primaryLang: "zh", secondaryLang: "ko") == OverlayStyle.minimumPrimarySize)
        let view = CaptionTextView(frame: NSRect(x: 0, y: 0, width: 600, height: 200))
        view.lines = 1
        let oneLine = view.primarySize
        view.lines = 3
        check("more lines in the same height → smaller text", view.primarySize < oneLine)
    }

    // Audience sharing through the bridge against a fake relay: settings are verified with the publish
    // key, the page's Content-Security-Policy then allows the relay, and rooms are created.
    private func checkSharing() async {
        let relayOrigin = "http://127.0.0.1:\(relay.port)"
        let policyBefore = await rawResponse("GET / HTTP/1.1\r\nHost: 127.0.0.1:\(server.port)\r\n\r\n")
        check("CSP allows no relay before one is set", !policyBefore.contains("127.0.0.1:\(relay.port)"))
        let script = """
        const h = window.webkit.messageHandlers.klt;
        const call = async (message) => JSON.parse(await h.postMessage(message));
        document.getElementById("keyDialog").close();
        document.getElementById("shareBtn").click();
        const setupShown = !document.getElementById("shareSetup").hidden;
        const wrongKey = await call({ action: "request", method: "POST", path: "/api/share/config", body: { url: origin, key: "kltp_wrong_0123456789abcdefghijklmnopqrstuv" } });
        const saved = await call({ action: "request", method: "POST", path: "/api/share/config", body: { url: origin + "/r/x", key: FakeKey } });
        const health = await call({ action: "request", method: "GET", path: "/api/health" });
        const room = await call({ action: "request", method: "POST", path: "/api/share/rooms", body: { title: "大會" } });
        return JSON.stringify({ setupShown, wrongKey, saved, health, room });
        """
        do {
            let raw = try await webView.callAsyncJavaScript(script, arguments: ["origin": relayOrigin, "FakeKey": FakeRelay.key], contentWorld: .page) as? String ?? "{}"
            let result = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any] ?? [:]
            check("share panel asks for a relay first", result["setupShown"] as? Bool == true)
            check("wrong publish key → 400", (result["wrongKey"] as? [String: Any])?["status"] as? Int == 400)
            let saved = result["saved"] as? [String: Any]
            check("relay saved as its origin", (saved?["data"] as? [String: Any])?["origin"] as? String == relayOrigin, "\(saved ?? [:])")
            let share = ((result["health"] as? [String: Any])?["data"] as? [String: Any])?["share"] as? [String: Any]
            check("health reports the relay", share?["configured"] as? Bool == true && share?["origin"] as? String == relayOrigin)
            let room = (result["room"] as? [String: Any])?["data"] as? [String: Any]
            check("room created with the publish key", room?["room"] as? String == "abcdefghjkmn" && relay.lastTitle == "大會", "\(room ?? [:])")
        } catch {
            check("sharing script", false, "\(error)")
        }
        let policyAfter = await rawResponse("GET / HTTP/1.1\r\nHost: 127.0.0.1:\(server.port)\r\n\r\n")
        check("CSP then allows exactly the relay", policyAfter.contains("connect-src 'self' https://api.openai.com wss://api.openai.com \(relayOrigin) ws://127.0.0.1:\(relay.port);"))
    }

    // `npm run relay:deploy` opens the app with keynote-live-translator://share-setup?url=…&key=…; the page
    // asks before connecting.
    private func checkSetupLink() async {
        let origin = "https://klt-relay.example.workers.dev"
        let parsed = ShareRules.parseSetupLink(URL(string: "keynote-live-translator://share-setup?url=\(origin.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!)&key=\(FakeRelay.key)")!)
        check("setup link parsed", parsed == ["url": origin, "key": FakeRelay.key], "\(parsed ?? [:])")
        let rejected = [
            "keynote-live-translator://share-setup?url=http%3A%2F%2Fevil.example&key=\(FakeRelay.key)",
            "keynote-live-translator://share-setup?url=\(origin)&key=nope",
            "keynote-live-translator://other?url=\(origin)&key=\(FakeRelay.key)",
            "https://share-setup?url=\(origin)&key=\(FakeRelay.key)",
        ].compactMap { URL(string: $0) }.compactMap(ShareRules.parseSetupLink)
        check("invalid setup links rejected (plain http, bad key, other host or scheme)", rejected.isEmpty)

        pendingShareSetup = ["url": origin, "key": FakeRelay.key]
        let script = """
        const h = window.webkit.messageHandlers.klt;
        const call = async (message) => JSON.parse(await h.postMessage(message));
        const first = await call({ action: "takeShareSetup" });
        const second = await call({ action: "takeShareSetup" });
        window.__kltShareSetup(first);
        await new Promise((resolve) => setTimeout(resolve, 100));
        const dialog = document.getElementById("confirmDialog");
        const asked = dialog.open ? document.getElementById("confirmMessage").textContent : "";
        document.getElementById("confirmCancelBtn").click();
        await new Promise((resolve) => setTimeout(resolve, 100));
        return JSON.stringify({ first, second, asked, closed: !dialog.open, panelOpen: !document.getElementById("sharePanel").hidden });
        """
        do {
            let raw = try await webView.callAsyncJavaScript(script, contentWorld: .page) as? String ?? "{}"
            let result = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any] ?? [:]
            check("setup link handed to the page once", (result["first"] as? [String: Any])?["url"] as? String == origin
                && (result["second"] as? [String: Any])?.isEmpty == true)
            let asked = result["asked"] as? String ?? ""
            check("page asks before connecting, naming the server", asked.contains("klt-relay.example.workers.dev"), asked)
            check("cancel leaves the settings alone", result["closed"] as? Bool == true && result["panelOpen"] as? Bool == true)
        } catch {
            check("setup link script", false, "\(error)")
        }
    }

    // The page's QR encoder, run in WebKit, decoded by Apple's Vision.
    private func checkQrCodes() async {
        let texts = [
            "https://klt-relay.example.workers.dev/r/abcdefghjkmn",
            "http://127.0.0.1:8788/r/k3m9x2p7q4ad",
            "https://captions.example.com.tw/r/" + String(repeating: "z", count: 16),
            "即時翻譯",
            String(repeating: "Keynote Live Translator ", count: 12),
        ]
        let script = """
        const { encodeQr } = await import("/js/qr.js");
        return JSON.stringify(texts.map((text) => { const qr = encodeQr(text); return { size: qr.size, bits: Array.from(qr.modules).join("") }; }));
        """
        do {
            let raw = try await webView.callAsyncJavaScript(script, arguments: ["texts": texts], contentWorld: .page) as? String ?? "[]"
            let codes = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [[String: Any]] ?? []
            var decoded: [String] = []
            for code in codes {
                decoded.append(decodeQr(size: code["size"] as? Int ?? 0, bits: code["bits"] as? String ?? "") ?? "")
            }
            check("QR codes from the page decode with Vision", decoded == texts, "\(decoded.map { String($0.prefix(30)) })")
        } catch {
            check("QR script", false, "\(error)")
        }
    }

    private func decodeQr(size: Int, bits: String) -> String? {
        let scale = 4
        let margin = 4
        let pixels = (size + margin * 2) * scale
        guard size > 0, bits.count == size * size,
              let context = CGContext(data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: pixels, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)
        else { return nil }
        context.setFillColor(gray: 1, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: pixels, height: pixels))
        context.setFillColor(gray: 0, alpha: 1)
        for (index, bit) in bits.enumerated() where bit == "1" {
            let x = index % size
            let y = index / size
            context.fill(CGRect(x: (x + margin) * scale, y: pixels - (y + margin + 1) * scale, width: scale, height: scale))
        }
        guard let image = context.makeImage() else { return nil }
        let request = VNDetectBarcodesRequest()
        request.symbologies = [.qr]
        try? VNImageRequestHandler(cgImage: image).perform([request])
        return request.results?.first?.payloadStringValue
    }

    private func checkDownsampler() {
        let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 2)!
        guard let downsampler = PCMDownsampler(inputFormat: format) else {
            check("downsampler", false)
            return
        }
        var chunks: [(Data, Float, Float)] = []
        for block in 0..<100 {
            let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 480)!
            buffer.frameLength = 480
            for frame in 0..<480 {
                let value = Float(0.5 * sin(Double(block * 480 + frame) * 2 * .pi * 1000 / 48_000))
                buffer.floatChannelData![0][frame] = value
                buffer.floatChannelData![1][frame] = value
            }
            chunks += downsampler.process(buffer)
        }
        let samples = chunks.count * PCMDownsampler.chunkSamples
        check("48 kHz stereo → 24 kHz mono, 50 ms chunks", abs(samples - 24_000) <= PCMDownsampler.chunkSamples && chunks.allSatisfy { $0.0.count == 2400 }, "\(samples) samples")
        let rms = chunks.dropFirst().map(\.1).reduce(0, +) / Float(max(1, chunks.count - 1))
        check("level is preserved (0.5 sine → RMS ≈ 0.35)", abs(rms - 0.354) < 0.03, "\(rms)")
    }

    private func rawResponse(_ request: String) async -> String {
        await withCheckedContinuation { continuation in
            let connection = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: server.port)!, using: .tcp)
            connection.start(queue: .main)
            connection.send(content: Data(request.utf8), completion: .contentProcessed { _ in })
            connection.receive(minimumIncompleteLength: 12, maximumLength: 65_536) { data, _, _, _ in
                connection.cancel()
                continuation.resume(returning: data.map { String(decoding: $0, as: UTF8.self) } ?? "")
            }
        }
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

// A stand-in for the Cloudflare relay (relay/): checks the publish key and hands out a room.
final class FakeRelay: @unchecked Sendable {
    static let key = "kltp_harness_0123456789abcdefghijklmnopqrstuv"
    private var listener: NWListener?
    private(set) var port: UInt16 = 0
    private(set) var lastTitle = ""

    func start() {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        let listener = try! NWListener(using: parameters)
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { [weak self] state in
            if case .ready = state {
                self?.port = listener.port?.rawValue ?? 0
                ready.signal()
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            connection.start(queue: .global())
            self?.receive(connection, Data())
        }
        listener.start(queue: .global())
        _ = ready.wait(timeout: .now() + 5)
        self.listener = listener
    }

    // Reads until the headers and the whole body (Content-Length) have arrived.
    private func receive(_ connection: NWConnection, _ buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, complete, _ in
            let buffer = buffer + (data ?? Data())
            let text = String(decoding: buffer, as: UTF8.self)
            if let end = buffer.range(of: Data("\r\n\r\n".utf8)) {
                let length = text.range(of: "(?i)content-length: *([0-9]+)", options: .regularExpression)
                    .flatMap { Int(text[$0].split(separator: ":")[1].trimmingCharacters(in: .whitespaces)) } ?? 0
                if buffer.count - end.upperBound >= length || complete {
                    self?.respond(connection, text)
                    return
                }
            }
            if complete { self?.respond(connection, text) } else { self?.receive(connection, buffer) }
        }
    }

    private func respond(_ connection: NWConnection, _ request: String) {
        let authorized = request.contains("Authorization: Bearer \(Self.key)") || request.contains("authorization: Bearer \(Self.key)")
        var status = 200
        var body = "{\"ok\":true}"
        if !authorized {
            status = 401
            body = "{\"error\":\"發佈金鑰不正確。\"}"
        } else if request.hasPrefix("POST /api/rooms") {
            if let range = request.range(of: "\r\n\r\n"),
               let json = try? JSONSerialization.jsonObject(with: Data(request[range.upperBound...].utf8)) as? [String: Any] {
                lastTitle = json["title"] as? String ?? ""
            }
            let origin = "127.0.0.1:\(port)"
            body = "{\"room\":\"abcdefghjkmn\",\"hostToken\":\"token\",\"viewerUrl\":\"http://\(origin)/r/abcdefghjkmn\",\"socketUrl\":\"ws://\(origin)/api/rooms/abcdefghjkmn/host\"}"
        }
        let bytes = Data(body.utf8)
        let head = "HTTP/1.1 \(status) X\r\nContent-Type: application/json\r\nContent-Length: \(bytes.count)\r\nConnection: close\r\n\r\n"
        connection.send(content: Data(head.utf8) + bytes, completion: .contentProcessed { _ in connection.cancel() })
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
