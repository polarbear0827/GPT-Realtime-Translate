// Prints what the macOS backend produces for each fixture, so tests/contract.test.mjs can compare it
// with the Node implementation. Usage: contract <realtime-config.json> <fixtures.json>
import Foundation

let arguments = CommandLine.arguments
let config = try RealtimeConfig.load(from: URL(fileURLWithPath: arguments[1]))
let fixtures = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: arguments[2]))) as? [[String: Any]] ?? []
let rules = RealtimeRules(config: config)
let gemini = GeminiRules(rules: rules)
let nowMs = Double(arguments[3]) ?? 0

var results: [Any] = []
for fixture in fixtures {
    let body = fixture["body"] as? [String: Any] ?? [:]
    do {
        switch fixture["kind"] as? String {
        case "translation":
            let params = try rules.validateTranslation(body)
            results.append(["ok": rules.translationSecretRequest(targetLanguage: params.targetLanguage, noiseReduction: params.noiseReduction)])
        case "transcription":
            results.append(["ok": rules.transcriptionSecretRequest(try rules.validateTranscription(body))])
        case "apikey":
            results.append(["ok": try RealtimeRules.validateApiKeyFormat(fixture["value"])])
        case "relayUrl":
            results.append(["ok": try ShareRules.normalizeRelayURL(fixture["value"])])
        case "publishKey":
            results.append(["ok": try ShareRules.validatePublishKey(fixture["value"])])
        case "roomTitle":
            results.append(["ok": ShareRules.normalizeRoomTitle(fixture["value"])])
        case "segment":
            let params = try rules.validateSegment(body)
            results.append(["ok": params.provider == "gemini" ? gemini.segmentRequest(params) : rules.segmentRequest(params)])
        case "geminiKey":
            results.append(["ok": try GeminiRules.validateKeyFormat(fixture["value"])])
        case "geminiTranslation":
            results.append(["ok": try gemini.translationSetup(body)])
        case "geminiTranscription":
            results.append(["ok": try gemini.transcriptionSetup(body)])
        case "geminiToken":
            results.append(["ok": gemini.tokenRequest(setup: try gemini.translationSetup(body), nowMs: nowMs)])
        case "geminiTokenResponse":
            results.append(["ok": try GeminiRules.parseToken(fixture["value"])])
        case "geminiSegmentResponse":
            results.append(["ok": try GeminiRules.parseSegmentResponse(fixture["value"])])
        case "segmentResponse":
            results.append(["ok": try RealtimeRules.parseSegmentResponse(fixture["value"])])
        case "csp":
            results.append(["ok": ShareRules.contentSecurityPolicy(relayOrigin: fixture["value"] as? String)])
        default:
            results.append(["error": ["status": 0, "message": "unknown fixture"]])
        }
    } catch let error as BackendError {
        results.append(["error": ["status": error.status, "message": error.message]])
    }
}
let output = try JSONSerialization.data(withJSONObject: results)
print(String(decoding: output, as: UTF8.self))
