import Foundation

// Native backend for the macOS app. Mirrors server/realtime.mjs (validation + payloads) and
// server/index.mjs (key handling, OpenAI calls); tests/contract.test.mjs keeps them in sync.
// The API key lives in memory, optionally persisted in the user's Keychain when they opt in.

struct RealtimeConfig: Decodable {
    struct Models: Decodable {
        let translation: String
        let transcription: String
        let segmentation: String
    }

    struct Gemini: Decodable {
        struct Models: Decodable {
            let translation: String
            let transcription: String
            let segmentation: String
        }

        struct Language: Decodable {
            let translate: String
            let transcribe: String
        }

        let models: Models
        let tokenTtlSeconds: Int
        let newSessionSeconds: Int
        let languages: [String: Language]
    }

    struct Segmentation: Decodable {
        let instructions: String
        let textMaxChars: Int
        let contextMaxChars: Int
        let maxOutputTokens: Int
    }

    struct Defaults: Decodable {
        let sourceLanguage: String
        let targetLanguage: String
        let transcriptionDelay: String
        let noiseReduction: String
    }

    struct Limits: Decodable {
        let requestBodyMaxBytes: Int
        let promptMaxChars: Int
        let keywordsMaxCount: Int
        let keywordMaxChars: Int
    }

    let models: Models
    let translationOutputLanguages: [String]
    let transcriptionLanguages: [String]
    let transcriptionDelays: [String]
    let noiseReductionTypes: [String]
    let defaults: Defaults
    let clientSecretTtlSeconds: Int
    let providers: [String]
    let gemini: Gemini
    let segmentation: Segmentation
    let limits: Limits

    static func load(from url: URL) throws -> RealtimeConfig {
        try JSONDecoder().decode(RealtimeConfig.self, from: Data(contentsOf: url))
    }
}

struct BackendError: Error {
    let status: Int
    let message: String
}

struct TranscriptionParams {
    let sourceLanguage: String
    let delay: String
    let prompt: String
    let keywords: [String]
    let noiseReduction: String
}

struct SegmentParams {
    let provider: String
    let language: String
    let text: String
    let context: String
}

struct RealtimeRules {
    let config: RealtimeConfig

    static func validateApiKeyFormat(_ value: Any?) throws -> String {
        let key = (value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !key.hasPrefix("sk-") || key.utf16.count < 20 || key.rangeOfCharacter(from: .whitespacesAndNewlines) != nil {
            throw BackendError(status: 400, message: "API key 格式不正確，應以 sk- 開頭。")
        }
        return key
    }

    func validateTranslation(_ body: [String: Any]) throws -> (targetLanguage: String, noiseReduction: String) {
        let target = stringOr(body["targetLanguage"], config.defaults.targetLanguage)
        guard config.translationOutputLanguages.contains(target) else {
            throw BackendError(status: 400, message: "不支援的翻譯目標語言。")
        }
        return (target, try validateNoiseReduction(body["noiseReduction"]))
    }

    func validateTranscription(_ body: [String: Any]) throws -> TranscriptionParams {
        let source = stringOr(body["sourceLanguage"], config.defaults.sourceLanguage)
        guard config.transcriptionLanguages.contains(source) else {
            throw BackendError(status: 400, message: "不支援的原文語言。")
        }
        let delay = stringOr(body["delay"], config.defaults.transcriptionDelay)
        guard config.transcriptionDelays.contains(delay) else {
            throw BackendError(status: 400, message: "不支援的轉錄延遲設定。")
        }
        let prompt = stringOr(body["prompt"], "").trimmingCharacters(in: .whitespacesAndNewlines)
        if prompt.utf16.count > config.limits.promptMaxChars {
            throw BackendError(status: 400, message: "情境說明最多 \(config.limits.promptMaxChars) 個字。")
        }
        return TranscriptionParams(
            sourceLanguage: source,
            delay: delay,
            prompt: prompt,
            keywords: try normalizeKeywords(body["keywords"]),
            noiseReduction: try validateNoiseReduction(body["noiseReduction"])
        )
    }

    // Same rules as normalizeKeywords() in server/realtime.mjs.
    func normalizeKeywords(_ input: Any?) throws -> [String] {
        var raw: [Any] = []
        if let array = input as? [Any] {
            raw = array
        } else if let text = input as? String {
            raw = text.components(separatedBy: CharacterSet(charactersIn: "\n,，、"))
        }
        var seen = Set<String>()
        var keywords: [String] = []
        for item in raw {
            guard let string = item as? String else { continue }
            var keyword = string.replacingOccurrences(of: "[<>\\r\\n]", with: " ", options: .regularExpression)
            keyword = keyword.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            keyword = keyword.trimmingCharacters(in: .whitespacesAndNewlines)
            let folded = keyword.lowercased()
            if keyword.isEmpty || seen.contains(folded) { continue }
            if keyword.utf16.count > config.limits.keywordMaxChars {
                throw BackendError(status: 400, message: "關鍵字「\(keyword.prefix(20))…」太長，每個最多 \(config.limits.keywordMaxChars) 字。")
            }
            seen.insert(folded)
            keywords.append(keyword)
        }
        if keywords.count > config.limits.keywordsMaxCount {
            throw BackendError(status: 400, message: "關鍵字最多 \(config.limits.keywordsMaxCount) 個。")
        }
        return keywords
    }

    func translationSecretRequest(targetLanguage: String, noiseReduction: String) -> [String: Any] {
        [
            "session": [
                "model": config.models.translation,
                "audio": [
                    "input": ["noise_reduction": ["type": noiseReduction]],
                    "output": ["language": targetLanguage],
                ],
            ],
        ]
    }

    func transcriptionSecretRequest(_ params: TranscriptionParams) -> [String: Any] {
        var transcription: [String: Any] = [
            "model": config.models.transcription,
            "languages": [params.sourceLanguage],
            "delay": params.delay,
        ]
        if !params.prompt.isEmpty { transcription["prompt"] = params.prompt }
        if !params.keywords.isEmpty { transcription["keywords"] = params.keywords }
        return [
            "expires_after": ["anchor": "created_at", "seconds": config.clientSecretTtlSeconds],
            "session": [
                "type": "transcription",
                "audio": [
                    "input": [
                        "format": ["type": "audio/pcm", "rate": 24000],
                        "transcription": transcription,
                        "noise_reduction": ["type": params.noiseReduction],
                        "turn_detection": NSNull(),
                    ],
                ],
            ],
        ]
    }

    // Same as validateSegmentRequest() / buildSegmentRequest() / parseSegmentResponse() in server/realtime.mjs.
    func validateSegment(_ body: [String: Any]) throws -> SegmentParams {
        let language = stringOr(body["language"], "")
        guard config.transcriptionLanguages.contains(language) || config.translationOutputLanguages.contains(language) else {
            throw BackendError(status: 400, message: "不支援的語言。")
        }
        let text = stringOr(body["text"], "").trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { throw BackendError(status: 400, message: "沒有要斷句的文字。") }
        if text.utf16.count > config.segmentation.textMaxChars { throw BackendError(status: 400, message: "要斷句的文字太長。") }
        let context = stringOr(body["context"], "").trimmingCharacters(in: .whitespacesAndNewlines)
        if context.utf16.count > config.segmentation.contextMaxChars { throw BackendError(status: 400, message: "前文太長。") }
        let provider = stringOr(body["provider"], "openai")
        guard config.providers.contains(provider) else { throw BackendError(status: 400, message: "不支援的服務商。") }
        return SegmentParams(provider: provider, language: language, text: text, context: context)
    }

    static func segmentContent(_ params: SegmentParams) -> String {
        params.context.isEmpty ? "Text:\n\(params.text)" : "Previous line:\n\(params.context)\n\nText:\n\(params.text)"
    }

    func segmentRequest(_ params: SegmentParams) -> [String: Any] {
        let content = Self.segmentContent(params)
        return [
            "model": config.models.segmentation,
            "temperature": 0,
            "max_completion_tokens": config.segmentation.maxOutputTokens,
            "messages": [
                ["role": "system", "content": config.segmentation.instructions],
                ["role": "user", "content": content],
            ],
        ]
    }

    static func parseSegmentResponse(_ json: Any?) throws -> [String] {
        guard let choices = (json as? [String: Any])?["choices"] as? [[String: Any]],
              let content = (choices.first?["message"] as? [String: Any])?["content"] as? String else {
            throw BackendError(status: 502, message: "OpenAI 回應格式錯誤。")
        }
        return content
            .replacingOccurrences(of: "\r\n", with: "\n")
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    private func validateNoiseReduction(_ value: Any?) throws -> String {
        let type = stringOr(value, config.defaults.noiseReduction)
        guard config.noiseReductionTypes.contains(type) else {
            throw BackendError(status: 400, message: "不支援的降噪設定。")
        }
        return type
    }

    private func stringOr(_ value: Any?, _ fallback: String) -> String {
        if let string = value as? String, !string.isEmpty { return string }
        return fallback
    }
}

// Google Gemini (Live API). Same rules and payloads as server/gemini.mjs.
struct GeminiRules {
    let rules: RealtimeRules
    var config: RealtimeConfig { rules.config }

    static func validateKeyFormat(_ value: Any?) throws -> String {
        let key = (value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard key.range(of: "^AIza[0-9A-Za-z_-]{30,}$", options: .regularExpression) != nil else {
            throw BackendError(status: 400, message: "Gemini API key 格式不正確，應以 AIza 開頭。")
        }
        return key
    }

    private func language(_ code: String) throws -> RealtimeConfig.Gemini.Language {
        guard let language = config.gemini.languages[code] else { throw BackendError(status: 400, message: "Gemini 不支援這個語言。") }
        return language
    }

    func translationSetup(_ body: [String: Any]) throws -> [String: Any] {
        let params = try rules.validateTranslation(body)
        return [
            "model": "models/\(config.gemini.models.translation)",
            "generationConfig": [
                "responseModalities": ["AUDIO"],
                "translationConfig": ["targetLanguageCode": try language(params.targetLanguage).translate, "echoTargetLanguage": true],
            ],
            "inputAudioTranscription": [String: Any](),
            "outputAudioTranscription": [String: Any](),
        ]
    }

    func transcriptionSetup(_ body: [String: Any]) throws -> [String: Any] {
        let params = try rules.validateTranscription(body)
        var transcription: [String: Any] = ["languageCodes": [try language(params.sourceLanguage).transcribe], "mode": "SMART"]
        if !params.keywords.isEmpty { transcription["customVocabulary"] = params.keywords }
        return [
            "model": "models/\(config.gemini.models.transcription)",
            "generationConfig": ["responseModalities": ["TEXT"]],
            "inputAudioTranscription": transcription,
        ]
    }

    func tokenRequest(setup: [String: Any], nowMs: Double) -> [String: Any] {
        [
            "uses": 1,
            "expireTime": Self.timestamp(nowMs + Double(config.gemini.tokenTtlSeconds) * 1000),
            "newSessionExpireTime": Self.timestamp(nowMs + Double(config.gemini.newSessionSeconds) * 1000),
            "bidiGenerateContentSetup": setup,
        ]
    }

    /// Like JavaScript's Date.toISOString(): 2026-10-14T03:04:05.000Z.
    static func timestamp(_ ms: Double) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date(timeIntervalSince1970: ms / 1000))
    }

    static func parseToken(_ json: Any?) throws -> String {
        guard let token = (json as? [String: Any])?["name"] as? String, token.hasPrefix("auth_tokens/") else {
            throw BackendError(status: 502, message: "Gemini 沒有回傳連線權杖。")
        }
        return token
    }

    func segmentRequest(_ params: SegmentParams) -> [String: Any] {
        [
            "systemInstruction": ["parts": [["text": config.segmentation.instructions]]],
            "contents": [["role": "user", "parts": [["text": RealtimeRules.segmentContent(params)]]]],
            "generationConfig": ["maxOutputTokens": 1024],
        ]
    }

    static func parseSegmentResponse(_ json: Any?) throws -> [String] {
        guard let candidates = (json as? [String: Any])?["candidates"] as? [[String: Any]],
              let parts = (candidates.first?["content"] as? [String: Any])?["parts"] as? [Any] else {
            throw BackendError(status: 502, message: "Gemini 回應格式錯誤。")
        }
        let text = parts.compactMap { part -> String? in
            guard let part = part as? [String: Any], let text = part["text"] as? String, (part["thought"] as? Bool) != true else { return nil }
            return text
        }.joined()
        return text
            .replacingOccurrences(of: "\r\n", with: "\n")
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }
}

// Audience-sharing relay settings and the page's Content-Security-Policy. Same rules as server/share.mjs.
enum ShareRules {
    static let roomTitleMaxChars = 80

    static func contentSecurityPolicy(relayOrigin: String?) -> String {
        var connect = "'self' https://api.openai.com wss://api.openai.com wss://generativelanguage.googleapis.com"
        if let relayOrigin { connect += " \(relayOrigin) \(websocketOrigin(relayOrigin))" }
        return "default-src 'self'; connect-src \(connect); media-src 'self' blob:; " +
            "img-src 'self' data:; style-src 'self'; script-src 'self'; worker-src 'self'; object-src 'none'; " +
            "base-uri 'self'; form-action 'none'; frame-ancestors 'none'"
    }

    /// https://host → wss://host, http://host → ws://host.
    static func websocketOrigin(_ origin: String) -> String {
        origin.hasPrefix("http") ? "ws" + origin.dropFirst(4) : origin
    }

    static func normalizeRelayURL(_ value: Any?) throws -> String {
        var text = (value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if text.isEmpty { throw BackendError(status: 400, message: "請輸入分享伺服器網址。") }
        if text.range(of: "^[a-zA-Z][a-zA-Z0-9+.-]*://", options: .regularExpression) == nil { text = "https://" + text }
        guard let components = URLComponents(string: text),
              let scheme = components.scheme?.lowercased(),
              let rawHost = components.host, !rawHost.isEmpty
        else { throw BackendError(status: 400, message: "分享伺服器網址格式不正確。") }
        let host = rawHost.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        let local = ["127.0.0.1", "localhost", "::1"].contains(host)
        guard scheme == "https" || (scheme == "http" && local), components.user == nil, components.password == nil else {
            throw BackendError(status: 400, message: "分享伺服器網址必須以 https:// 開頭。")
        }
        var origin = "\(scheme)://\(host.contains(":") ? "[\(host)]" : host)"
        if let port = components.port, !(scheme == "https" && port == 443), !(scheme == "http" && port == 80) {
            origin += ":\(port)"
        }
        return origin
    }

    static func validatePublishKey(_ value: Any?) throws -> String {
        let key = (value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard key.range(of: "^kltp_[A-Za-z0-9_-]{32,96}$", options: .regularExpression) != nil else {
            throw BackendError(status: 400, message: "發佈金鑰格式不正確，應以 kltp_ 開頭。")
        }
        return key
    }

    static let setupScheme = "keynote-live-translator"

    /// keynote-live-translator://share-setup?url=…&key=… — sent by `npm run relay:deploy` so the app
    /// connects to the new relay without copying anything. Returns nil unless both values are valid.
    static func parseSetupLink(_ url: URL) -> [String: String]? {
        guard url.scheme?.lowercased() == setupScheme,
              url.host?.lowercased() == "share-setup",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              let origin = try? normalizeRelayURL(items.first(where: { $0.name == "url" })?.value),
              let key = try? validatePublishKey(items.first(where: { $0.name == "key" })?.value)
        else { return nil }
        return ["url": origin, "key": key]
    }

    static func normalizeRoomTitle(_ value: Any?) -> String {
        guard let text = value as? String else { return "" }
        let spaced = text
            .replacingOccurrences(of: "[\\u0000-\\u001f\\u007f]", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return String(decoding: Array(spaced.utf16.prefix(roomTitleMaxChars)), as: UTF16.self)
    }
}

@MainActor
final class RealtimeBackend {
    private let rules: RealtimeRules
    private let gemini: GeminiRules
    private let version: String
    private let session: URLSession
    private let keyStore: KeyStoring
    private let geminiKeyStore: KeyStoring
    private let relayStore: KeyStoring
    private var apiKey: String?
    private var rememberedKey = false
    private var geminiKey: String?
    private var rememberedGeminiKey = false
    private var share: (origin: String, key: String)?
    /// The page may only connect to the configured relay; the host updates its CSP when this changes.
    var onShareOriginChange: ((String?) -> Void)?
    var shareOrigin: String? { share?.origin }

    init(
        config: RealtimeConfig,
        version: String,
        keyStore: KeyStoring = KeychainStore(),
        geminiKeyStore: KeyStoring = KeychainStore(account: "gemini-api-key", label: "Keynote Live Translator Gemini API key"),
        relayStore: KeyStoring = KeychainStore(account: "share-relay", label: "Keynote Live Translator 分享伺服器")
    ) {
        rules = RealtimeRules(config: config)
        gemini = GeminiRules(rules: rules)
        self.version = version
        self.keyStore = keyStore
        self.geminiKeyStore = geminiKeyStore
        self.relayStore = relayStore
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        configuration.urlCache = nil
        session = URLSession(configuration: configuration)
        if let stored = keyStore.load() {
            apiKey = stored
            rememberedKey = true
        }
        if let stored = geminiKeyStore.load() {
            geminiKey = stored
            rememberedGeminiKey = true
        }
        if let stored = relayStore.load()?.data(using: .utf8),
           let saved = try? JSONSerialization.jsonObject(with: stored) as? [String: String],
           let origin = try? ShareRules.normalizeRelayURL(saved["origin"]),
           let key = try? ShareRules.validatePublishKey(saved["key"]) {
            share = (origin, key)
        }
    }

    // Routes the same API surface as the dev server. Returns (HTTP-like status, JSON object).
    func handle(method: String, path: String, body: [String: Any]) async -> (Int, Any) {
        do {
            switch (method, path) {
            case ("GET", "/api/health"):
                return (200, [
                    "ok": true,
                    "version": version,
                    "hasApiKey": apiKey != nil,
                    "rememberedKey": rememberedKey,
                    "gemini": ["hasKey": geminiKey != nil, "rememberedKey": rememberedGeminiKey],
                    "share": ["configured": share != nil, "origin": (share?.origin as Any?) ?? NSNull()],
                ])
            case ("POST", "/api/share/config"):
                let origin = try ShareRules.normalizeRelayURL(body["url"])
                let key = try ShareRules.validatePublishKey(body["key"])
                _ = try await relayCall(origin: origin, key: key, method: "GET", path: "/api/verify", body: nil)
                share = (origin, key)
                let saved = try JSONSerialization.data(withJSONObject: ["origin": origin, "key": key])
                relayStore.save(String(decoding: saved, as: UTF8.self))
                onShareOriginChange?(origin)
                return (200, ["ok": true, "origin": origin])
            case ("DELETE", "/api/share/config"):
                share = nil
                relayStore.delete()
                onShareOriginChange?(nil)
                return (200, ["ok": true])
            case ("POST", "/api/share/rooms"):
                guard let share else { throw BackendError(status: 409, message: "尚未設定分享伺服器。") }
                let room = try await relayCall(
                    origin: share.origin,
                    key: share.key,
                    method: "POST",
                    path: "/api/rooms",
                    body: ["title": ShareRules.normalizeRoomTitle(body["title"])]
                )
                return (200, room)
            case ("POST", "/api/key"):
                let key = try RealtimeRules.validateApiKeyFormat(body["apiKey"])
                let warnings = try await verify(key: key)
                apiKey = key
                let remember = body["remember"] as? Bool ?? false
                if remember {
                    rememberedKey = keyStore.save(key)
                } else {
                    keyStore.delete()
                    rememberedKey = false
                }
                return (200, ["ok": true, "remembered": rememberedKey, "warnings": warnings])
            case ("DELETE", "/api/key"):
                apiKey = nil
                rememberedKey = false
                keyStore.delete()
                return (200, ["ok": true])
            case ("POST", "/api/realtime/translation-client-secret"):
                let params = try rules.validateTranslation(body)
                return try await createClientSecret(
                    endpoint: "https://api.openai.com/v1/realtime/translations/client_secrets",
                    payload: rules.translationSecretRequest(targetLanguage: params.targetLanguage, noiseReduction: params.noiseReduction)
                )
            case ("POST", "/api/realtime/transcription-client-secret"):
                let params = try rules.validateTranscription(body)
                return try await createClientSecret(
                    endpoint: "https://api.openai.com/v1/realtime/client_secrets",
                    payload: rules.transcriptionSecretRequest(params)
                )
            case ("POST", "/api/segment"):
                let params = try rules.validateSegment(body)
                if params.provider == "gemini" {
                    let data = try await geminiCall(
                        path: "models/\(rules.config.gemini.models.segmentation):generateContent",
                        body: gemini.segmentRequest(params),
                        timeout: 6
                    )
                    return (200, ["lines": try GeminiRules.parseSegmentResponse(data)])
                }
                return try await segment(params)
            case ("POST", "/api/gemini/key"):
                let key = try GeminiRules.validateKeyFormat(body["apiKey"])
                let warnings = try await verifyGemini(key: key)
                geminiKey = key
                if body["remember"] as? Bool ?? false {
                    rememberedGeminiKey = geminiKeyStore.save(key)
                } else {
                    geminiKeyStore.delete()
                    rememberedGeminiKey = false
                }
                return (200, ["ok": true, "remembered": rememberedGeminiKey, "warnings": warnings])
            case ("DELETE", "/api/gemini/key"):
                geminiKey = nil
                rememberedGeminiKey = false
                geminiKeyStore.delete()
                return (200, ["ok": true])
            case ("POST", "/api/gemini/translation-token"):
                return try await geminiToken(setup: try gemini.translationSetup(body))
            case ("POST", "/api/gemini/transcription-token"):
                return try await geminiToken(setup: try gemini.transcriptionSetup(body))
            default:
                return (404, ["error": "Not found."])
            }
        } catch let error as BackendError {
            return (error.status, ["error": error.message])
        } catch {
            return (500, ["error": "Internal error."])
        }
    }

    /// A translation WebSocket authenticated with the API key (system audio goes straight from the app to it).
    func makeTranslationSocket(id: String, body: [String: Any], audioEnabled: Bool) throws -> TranslationSocket {
        guard let apiKey else { throw BackendError(status: 401, message: "尚未設定 API key。") }
        let params = try rules.validateTranslation(body)
        return TranslationSocket(
            id: id,
            apiKey: apiKey,
            model: rules.config.models.translation,
            targetLanguage: params.targetLanguage,
            audioEnabled: audioEnabled
        )
    }

    private func createClientSecret(endpoint: String, payload: [String: Any]) async throws -> (Int, Any) {
        guard let apiKey else { throw BackendError(status: 401, message: "尚未設定 API key。") }
        var request = URLRequest(url: URL(string: endpoint)!)
        request.httpMethod = "POST"
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("local-keynote-user", forHTTPHeaderField: "OpenAI-Safety-Identifier")
        request.httpBody = try JSONSerialization.data(withJSONObject: payload)
        do {
            let (data, response) = try await session.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 502
            let json = (try? JSONSerialization.jsonObject(with: data)) ?? ["error": "OpenAI 回應格式錯誤。"]
            return (status, json)
        } catch let error as URLError where error.code == .timedOut {
            throw BackendError(status: 504, message: "OpenAI 回應逾時，請稍後再試。")
        } catch {
            throw BackendError(status: 502, message: "無法連線到 OpenAI，請檢查網路。")
        }
    }

    // Same as geminiCall() in server/index.mjs: POST to the Gemini API with the key.
    private func geminiCall(path: String, body: [String: Any], timeout: TimeInterval) async throws -> Any {
        guard let geminiKey else { throw BackendError(status: 401, message: "尚未設定 Gemini API key。") }
        var request = URLRequest(url: URL(string: "https://generativelanguage.googleapis.com/v1beta/\(path)")!)
        request.httpMethod = "POST"
        request.timeoutInterval = timeout
        request.setValue(geminiKey, forHTTPHeaderField: "x-goog-api-key")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let error as URLError where error.code == .timedOut {
            throw BackendError(status: 504, message: "Gemini 回應逾時。")
        } catch {
            throw BackendError(status: 502, message: "無法連線到 Gemini，請檢查網路。")
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 502
        let json = try? JSONSerialization.jsonObject(with: data)
        guard (200..<300).contains(status) else {
            let message = ((json as? [String: Any])?["error"] as? [String: Any])?["message"] as? String
            throw BackendError(status: status, message: message ?? "Gemini 回應錯誤（\(status)）。")
        }
        return json ?? [:]
    }

    // A single-use ephemeral token locked to `setup`; the page sends the same setup when it connects.
    private func geminiToken(setup: [String: Any]) async throws -> (Int, Any) {
        guard geminiKey != nil else { throw BackendError(status: 401, message: "尚未設定 Gemini API key。") }
        let request = gemini.tokenRequest(setup: setup, nowMs: Date().timeIntervalSince1970 * 1000)
        let data = try await geminiCall(path: "auth_tokens", body: request, timeout: 15)
        return (200, ["token": try GeminiRules.parseToken(data), "setup": setup])
    }

    // Same as segment() in server/index.mjs.
    private func segment(_ params: SegmentParams) async throws -> (Int, Any) {
        guard let apiKey else { throw BackendError(status: 401, message: "尚未設定 API key。") }
        var request = URLRequest(url: URL(string: "https://api.openai.com/v1/chat/completions")!)
        request.httpMethod = "POST"
        request.timeoutInterval = 6
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("local-keynote-user", forHTTPHeaderField: "OpenAI-Safety-Identifier")
        request.httpBody = try JSONSerialization.data(withJSONObject: rules.segmentRequest(params))
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let error as URLError where error.code == .timedOut {
            throw BackendError(status: 504, message: "OpenAI 回應逾時。")
        } catch {
            throw BackendError(status: 502, message: "無法連線到 OpenAI，請檢查網路。")
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 502
        let json = try? JSONSerialization.jsonObject(with: data)
        guard (200..<300).contains(status) else {
            let message = ((json as? [String: Any])?["error"] as? [String: Any])?["message"] as? String
            return (status, ["error": message ?? "OpenAI 回應錯誤（\(status)）。"])
        }
        return (200, ["lines": try RealtimeRules.parseSegmentResponse(json)])
    }

    // Same as relayCall() in server/index.mjs.
    private func relayCall(origin: String, key: String, method: String, path: String, body: [String: Any]?) async throws -> [String: Any] {
        guard let url = URL(string: origin + path) else { throw BackendError(status: 400, message: "分享伺服器網址格式不正確。") }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let error as URLError where error.code == .timedOut {
            throw BackendError(status: 502, message: "分享伺服器回應逾時。")
        } catch {
            throw BackendError(status: 502, message: "無法連線到分享伺服器，請檢查網址與網路。")
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 502
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        if status == 401 { throw BackendError(status: 400, message: "分享伺服器拒絕這把發佈金鑰。") }
        guard (200..<300).contains(status) else {
            throw BackendError(status: 502, message: json["error"] as? String ?? "分享伺服器回應錯誤（\(status)）。")
        }
        if path == "/api/rooms" {
            let socket = json["socketUrl"] as? String ?? ""
            guard json["room"] is String, json["hostToken"] is String, socket.hasPrefix(ShareRules.websocketOrigin(origin) + "/") else {
                throw BackendError(status: 502, message: "分享伺服器的回應格式不正確。")
            }
        }
        return json
    }

    // Same checks as verifyGeminiKey() in server/index.mjs.
    private func verifyGemini(key: String) async throws -> [String] {
        let models = rules.config.gemini.models
        var statuses: [(String, Int)] = []
        await withTaskGroup(of: (String, Int).self) { group in
            for model in [models.translation, models.transcription, models.segmentation] {
                group.addTask { [session] in
                    var request = URLRequest(url: URL(string: "https://generativelanguage.googleapis.com/v1beta/models/\(model)")!)
                    request.setValue(key, forHTTPHeaderField: "x-goog-api-key")
                    request.timeoutInterval = 10
                    let status = (try? await session.data(for: request)).flatMap { ($0.1 as? HTTPURLResponse)?.statusCode } ?? 0
                    return (model, status)
                }
            }
            for await result in group { statuses.append(result) }
        }
        if statuses.contains(where: { $0.1 == 400 || $0.1 == 401 }) {
            throw BackendError(status: 400, message: "Google 拒絕這把金鑰（無效或已撤銷）。")
        }
        var warnings: [String] = []
        for (model, status) in statuses.sorted(by: { $0.0 < $1.0 }) {
            let warning: String?
            switch status {
            case 0: warning = "暫時無法連線到 Google 驗證金鑰，已先儲存。"
            case 403, 404:
                warning = model == models.segmentation
                    ? "這把金鑰目前無法使用 \(model)，智慧斷句會改用一般斷句。"
                    : "這把金鑰目前無法使用 \(model)。"
            case 400...: warning = "驗證 \(model) 時 Google 回應 \(status)。"
            default: warning = nil
            }
            if let warning, !warnings.contains(warning) { warnings.append(warning) }
        }
        return warnings
    }

    // Same checks as verifyApiKey() in server/index.mjs.
    private func verify(key: String) async throws -> [String] {
        let models = [rules.config.models.translation, rules.config.models.transcription, rules.config.models.segmentation]
        var statuses: [(String, Int)] = []
        await withTaskGroup(of: (String, Int).self) { group in
            for model in models {
                group.addTask { [session] in
                    var request = URLRequest(url: URL(string: "https://api.openai.com/v1/models/\(model)")!)
                    request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
                    request.timeoutInterval = 10
                    let status = (try? await session.data(for: request)).flatMap { ($0.1 as? HTTPURLResponse)?.statusCode } ?? 0
                    return (model, status)
                }
            }
            for await result in group { statuses.append(result) }
        }
        if statuses.contains(where: { $0.1 == 401 }) {
            throw BackendError(status: 400, message: "OpenAI 拒絕這把金鑰（無效或已撤銷）。")
        }
        var warnings: [String] = []
        for (model, status) in statuses.sorted(by: { $0.0 < $1.0 }) {
            let warning: String?
            switch status {
            case 0: warning = "暫時無法連線到 OpenAI 驗證金鑰，已先儲存。"
            case 403, 404:
                warning = model == rules.config.models.segmentation
                    ? "這把金鑰目前無法使用 \(model)，智慧斷句會改用一般斷句。"
                    : "這把金鑰目前無法使用 \(model)。"
            case 400...: warning = "驗證 \(model) 時 OpenAI 回應 \(status)。"
            default: warning = nil
            }
            if let warning, !warnings.contains(warning) { warnings.append(warning) }
        }
        return warnings
    }
}
