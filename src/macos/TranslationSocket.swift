import Foundation

// A gpt-realtime-translate session over WebSocket, opened by the app with the API key (OpenAI's
// documented server-side flow). Used for system audio: the audio is already in the app, and a
// WebSocket over TLS works on networks where WebRTC (UDP/ICE) can't connect.
// All methods and callbacks run on the main thread.
final class TranslationSocket: @unchecked Sendable { // main-thread confined (see above)
    let id: String
    var audioEnabled: Bool
    /// Events forwarded to the page (transcript deltas, errors, session.closed), as raw JSON text.
    var onEvent: ((String) -> Void)?
    /// The connection ended without close() being called.
    var onClosed: ((String) -> Void)?

    private let session = URLSession(configuration: .ephemeral)
    private let task: URLSessionWebSocketTask
    private let targetLanguage: String
    private var opened = false
    private var closing = false
    private var openContinuation: CheckedContinuation<Void, Error>?
    private var closedContinuation: CheckedContinuation<Void, Never>?

    private static let forwarded: Set<String> = [
        "session.output_transcript.delta",
        "session.input_transcript.delta",
        "session.closed",
        "error",
    ]

    init(id: String, apiKey: String, model: String, targetLanguage: String, audioEnabled: Bool) {
        self.id = id
        self.audioEnabled = audioEnabled
        self.targetLanguage = targetLanguage
        var components = URLComponents(string: "wss://api.openai.com/v1/realtime/translations")!
        components.queryItems = [URLQueryItem(name: "model", value: model)]
        var request = URLRequest(url: components.url!)
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("local-keynote-user", forHTTPHeaderField: "OpenAI-Safety-Identifier")
        task = session.webSocketTask(with: request)
        task.maximumMessageSize = 16 * 1024 * 1024
    }

    /// Connects and sets the output language; returns once the service has answered.
    func open(timeout: TimeInterval = 15) async throws {
        task.resume()
        receiveNext()
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            openContinuation = continuation
            send(["type": "session.update", "session": ["audio": ["output": ["language": targetLanguage]]]])
            DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in
                self?.finishOpen(SystemAudioError(message: "翻譯連線逾時（OpenAI 沒有回應）。"))
            }
        }
    }

    /// 24 kHz mono PCM16, base64.
    func append(_ base64: String) {
        guard opened, audioEnabled, !closing else { return }
        send(["type": "session.input_audio_buffer.append", "audio": base64])
    }

    /// Graceful close lets the service finish translating audio it already has (session.close → session.closed).
    func close(graceful: Bool) async {
        guard !closing else { return }
        closing = true
        if graceful && opened {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                closedContinuation = continuation
                send(["type": "session.close"])
                DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in self?.resumeClosed() }
            }
        }
        task.cancel(with: .normalClosure, reason: nil)
        session.finishTasksAndInvalidate()
    }

    private func receiveNext() {
        task.receive { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case .success(.string(let text)):
                    self.handle(text)
                    self.receiveNext()
                case .success:
                    self.receiveNext()
                case .failure:
                    self.handleFailure()
                }
            }
        }
    }

    private func handle(_ text: String) {
        guard let data = text.data(using: .utf8),
              let event = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = event["type"] as? String
        else { return }
        if !opened {
            if type == "error" {
                let message = (event["error"] as? [String: Any])?["message"] as? String
                finishOpen(SystemAudioError(message: message ?? "翻譯連線失敗。"))
                return
            }
            finishOpen(nil)
        }
        if Self.forwarded.contains(type) { onEvent?(text) }
        if type == "session.closed" { resumeClosed() }
    }

    private func handleFailure() {
        let status = (task.response as? HTTPURLResponse)?.statusCode
        let message: String
        switch status {
        case 401: message = "OpenAI 拒絕這把金鑰（401）。"
        case .some(let code) where code >= 400: message = "翻譯連線失敗（HTTP \(code)）。"
        default: message = "翻譯連線中斷。"
        }
        if openContinuation != nil {
            finishOpen(SystemAudioError(message: message))
            return
        }
        resumeClosed()
        if !closing {
            closing = true
            session.finishTasksAndInvalidate()
            onClosed?(message)
        }
    }

    private func finishOpen(_ error: Error?) {
        guard let continuation = openContinuation else { return }
        openContinuation = nil
        if let error {
            closing = true
            task.cancel(with: .goingAway, reason: nil)
            session.finishTasksAndInvalidate()
            continuation.resume(throwing: error)
        } else {
            opened = true
            continuation.resume()
        }
    }

    private func resumeClosed() {
        closedContinuation?.resume()
        closedContinuation = nil
    }

    private func send(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object), let text = String(data: data, encoding: .utf8) else { return }
        task.send(.string(text)) { _ in }
    }
}
