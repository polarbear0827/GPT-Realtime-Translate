import Foundation

// Native backend for the macOS app. Mirrors server/realtime.mjs (validation + payloads) and
// server/index.mjs (key handling, OpenAI calls); tests/contract.test.mjs keeps them in sync.
// The API key lives in memory, optionally persisted in the user's Keychain when they opt in.

struct RealtimeConfig: Decodable {
    struct Models: Decodable {
        let translation: String
        let transcription: String
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

@MainActor
final class RealtimeBackend {
    private let rules: RealtimeRules
    private let version: String
    private let session: URLSession
    private let keyStore: KeyStoring
    private var apiKey: String?
    private var rememberedKey = false

    init(config: RealtimeConfig, version: String, keyStore: KeyStoring = KeychainStore()) {
        rules = RealtimeRules(config: config)
        self.version = version
        self.keyStore = keyStore
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        configuration.urlCache = nil
        session = URLSession(configuration: configuration)
        if let stored = keyStore.load() {
            apiKey = stored
            rememberedKey = true
        }
    }

    // Routes the same API surface as the dev server. Returns (HTTP-like status, JSON object).
    func handle(method: String, path: String, body: [String: Any]) async -> (Int, Any) {
        do {
            switch (method, path) {
            case ("GET", "/api/health"):
                return (200, ["ok": true, "version": version, "hasApiKey": apiKey != nil, "rememberedKey": rememberedKey])
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
            default:
                return (404, ["error": "Not found."])
            }
        } catch let error as BackendError {
            return (error.status, ["error": error.message])
        } catch {
            return (500, ["error": "Internal error."])
        }
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

    // Same checks as verifyApiKey() in server/index.mjs.
    private func verify(key: String) async throws -> [String] {
        let models = [rules.config.models.translation, rules.config.models.transcription]
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
            case 403, 404: warning = "這把金鑰目前無法使用 \(model)。"
            case 400...: warning = "驗證 \(model) 時 OpenAI 回應 \(status)。"
            default: warning = nil
            }
            if let warning, !warnings.contains(warning) { warnings.append(warning) }
        }
        return warnings
    }
}
