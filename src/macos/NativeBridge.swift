import AppKit
import UniformTypeIdentifiers
import WebKit

// What the bridge needs from the window that hosts the page (AppDelegate in the app, a stub in tests).
@MainActor
protocol BridgeHost: AnyObject {
    func isTrustedFrame(_ frame: WKFrameInfo) -> Bool
    func saveFile(name: String, content: String, completion: @escaping ([String: Any]) -> Void)
    func setFullscreen(_ enabled: Bool) -> Bool
    func setKeepAwake(_ enabled: Bool)
    func setLeaveGuard(enabled: Bool, message: String)
    func openDisplayWindow()
    var systemAudioSupported: Bool { get }
    func startSystemAudio(muteSource: Bool) throws
    func stopSystemAudio()
    var overlayState: [String: Any] { get }
    func configureOverlay(visible: Bool?, locked: Bool?, fontScale: Double?) -> [String: Any]
    func updateOverlay(primary: OverlayLine?, secondary: OverlayLine?)
    func setAppearance(_ theme: String)
}

// window.webkit.messageHandlers.klt — the page's only way to reach native code. Messages are
// accepted only from the main frame of our own origin; every reply is a JSON string.
@MainActor
final class NativeBridge: NSObject, WKScriptMessageHandlerWithReply {
    weak var host: BridgeHost?
    private let backend: RealtimeBackend
    private let version: String

    init(backend: RealtimeBackend, version: String) {
        self.backend = backend
        self.version = version
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        guard let host, host.isTrustedFrame(message.frameInfo) else {
            replyHandler(nil, "Forbidden")
            return
        }
        guard let body = message.body as? [String: Any], let action = body["action"] as? String else {
            replyHandler(nil, "Bad request")
            return
        }
        let reply: (Any) -> Void = { value in replyHandler(Self.json(value), nil) }

        switch action {
        case "info":
            reply([
                "platform": "macos",
                "version": version,
                "supports": [
                    "rememberKey": true,
                    "nativeSave": true,
                    "displayWindow": true,
                    "systemAudio": host.systemAudioSupported,
                    "overlay": true,
                ],
                "rememberKeyLabel": "記住金鑰（存在 macOS 鑰匙圈）",
                "overlay": host.overlayState,
            ])
        case "request":
            let method = body["method"] as? String ?? "GET"
            let path = body["path"] as? String ?? ""
            let payload = body["body"] as? [String: Any] ?? [:]
            Task { @MainActor in
                let (status, data) = await self.backend.handle(method: method, path: path, body: payload)
                reply(["status": status, "data": data])
            }
        case "saveFile":
            host.saveFile(
                name: body["filename"] as? String ?? "transcript.txt",
                content: body["content"] as? String ?? ""
            ) { result in reply(result) }
        case "setFullscreen":
            reply(["fullscreen": host.setFullscreen(body["enabled"] as? Bool ?? false)])
        case "setKeepAwake":
            host.setKeepAwake(body["enabled"] as? Bool ?? false)
            reply(["ok": true])
        case "setLeaveGuard":
            host.setLeaveGuard(enabled: body["enabled"] as? Bool ?? false, message: body["message"] as? String ?? "")
            reply(["ok": true])
        case "openDisplayWindow":
            host.openDisplayWindow()
            reply(["opened": true])
        case "systemAudioStart":
            do {
                try host.startSystemAudio(muteSource: body["muteSource"] as? Bool ?? false)
                reply(["ok": true])
            } catch {
                replyHandler(nil, error.localizedDescription)
            }
        case "systemAudioStop":
            host.stopSystemAudio()
            reply(["ok": true])
        case "overlay":
            reply(host.configureOverlay(
                visible: body["visible"] as? Bool,
                locked: body["locked"] as? Bool,
                fontScale: body["fontScale"] as? Double
            ))
        case "setAppearance":
            host.setAppearance(body["theme"] as? String ?? "system")
            reply(["ok": true])
        case "overlayUpdate":
            host.updateOverlay(primary: OverlayLine(json: body["primary"]), secondary: OverlayLine(json: body["secondary"]))
            reply(["ok": true])
        default:
            replyHandler(nil, "Unknown action")
        }
    }

    static func json(_ value: Any) -> String {
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value)
        else { return "{}" }
        return String(decoding: data, as: UTF8.self)
    }
}
