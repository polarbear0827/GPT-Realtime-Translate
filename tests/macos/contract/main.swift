// Prints what the macOS backend produces for each fixture, so tests/contract.test.mjs can compare it
// with the Node implementation. Usage: contract <realtime-config.json> <fixtures.json>
import Foundation

let arguments = CommandLine.arguments
let config = try RealtimeConfig.load(from: URL(fileURLWithPath: arguments[1]))
let fixtures = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: arguments[2]))) as? [[String: Any]] ?? []
let rules = RealtimeRules(config: config)

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
        default:
            results.append(["error": ["status": 0, "message": "unknown fixture"]])
        }
    } catch let error as BackendError {
        results.append(["error": ["status": error.status, "message": error.message]])
    }
}
let output = try JSONSerialization.data(withJSONObject: results)
print(String(decoding: output, as: UTF8.self))
