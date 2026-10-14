// The dev server (Node) and the macOS app (Swift) implement the same validation and OpenAI payloads.
// This compiles the Swift rules and checks both produce identical results for the same fixtures.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ValidationError,
  buildTranscriptionSecretRequest,
  buildSegmentRequest,
  buildTranslationSecretRequest,
  parseSegmentResponse,
  validateApiKeyFormat,
  validateSegmentRequest,
  validateTranscriptionRequest,
  validateTranslationRequest,
} from "../server/realtime.mjs";
import {
  buildGeminiSegmentRequest,
  buildGeminiTokenRequest,
  geminiTranscriptionSetup,
  geminiTranslationSetup,
  parseGeminiSegmentResponse,
  parseGeminiToken,
  validateGeminiKeyFormat,
} from "../server/gemini.mjs";
import { contentSecurityPolicy, normalizeRelayUrl, normalizeRoomTitle, validatePublishKey } from "../server/share.mjs";

// A fixed clock for token expiry times (whole seconds, so both languages format them the same way).
const NOW_MS = Date.UTC(2026, 9, 14, 3, 4, 5);

const root = new URL("..", import.meta.url).pathname;
const configPath = join(root, "public/realtime-config.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));

const fixtures = [
  { kind: "translation", body: { targetLanguage: "ja", noiseReduction: "far_field" } },
  { kind: "translation", body: {} },
  { kind: "translation", body: { targetLanguage: "xx" } },
  { kind: "transcription", body: {} },
  {
    kind: "transcription",
    body: { sourceLanguage: "zh", delay: "high", prompt: "  產品發表會  ", keywords: "OpenAI\nopenai\n<b>GPT</b>, Keynote、 Live  Translator\n\n" },
  },
  { kind: "transcription", body: { keywords: ["Alpha", "Beta", 42, "  gamma  "] } },
  { kind: "transcription", body: { keywords: ["x".repeat(61)] } },
  { kind: "transcription", body: { delay: "fast" } },
  { kind: "transcription", body: { sourceLanguage: "xx" } },
  { kind: "transcription", body: { prompt: "字".repeat(501) } },
  { kind: "transcription", body: { noiseReduction: "studio" } },
  { kind: "apikey", value: "  sk-abcdefghijklmnopqrstuvwxyz  " },
  { kind: "apikey", value: "sk-short" },
  { kind: "apikey", value: "sk-abc def ghi jkl mno pqr" },
  { kind: "apikey", value: 42 },
  { kind: "relayUrl", value: "https://klt-relay.example.workers.dev" },
  { kind: "relayUrl", value: "  HTTPS://Klt-Relay.Example.workers.dev/r/abc?x=1  " },
  { kind: "relayUrl", value: "klt-relay.example.workers.dev" },
  { kind: "relayUrl", value: "https://captions.example.com:443/" },
  { kind: "relayUrl", value: "https://captions.example.com:8443" },
  { kind: "relayUrl", value: "http://127.0.0.1:8788" },
  { kind: "relayUrl", value: "http://localhost:8788/" },
  { kind: "relayUrl", value: "http://klt-relay.example.workers.dev" },
  { kind: "relayUrl", value: "ftp://example.com" },
  { kind: "relayUrl", value: "https://user:pass@example.com" },
  { kind: "relayUrl", value: "https://exa mple.com" },
  { kind: "relayUrl", value: "" },
  { kind: "relayUrl", value: 42 },
  { kind: "publishKey", value: "  kltp_0123456789abcdefghijklmnopqrstuvwxyzABCDEF  " },
  { kind: "publishKey", value: "kltp_short" },
  { kind: "publishKey", value: "sk-0123456789abcdefghijklmnopqrstuvwxyzABCDEF" },
  { kind: "publishKey", value: "kltp_0123456789abcdefghijklmnopqrstuv wxyz" },
  { kind: "roomTitle", value: "  2026 AI\t開發者\n\n大會  " },
  { kind: "roomTitle", value: "講".repeat(90) },
  { kind: "roomTitle", value: null },
  { kind: "segment", body: { language: "zh", text: "  所以他的大樹又快上線了再看男槍  ", context: "儘管前期人頭一直往下掉" } },
  { kind: "segment", body: { language: "en", text: "If he starts to come online this could get difficult" } },
  { kind: "segment", body: { language: "zh", text: "   " } },
  { kind: "segment", body: { language: "xx", text: "hello" } },
  { kind: "segment", body: { language: "zh", text: "字".repeat(401) } },
  { kind: "segment", body: { language: "zh", text: "字".repeat(400), context: "前".repeat(201) } },
  { kind: "segment", body: { language: "ja", text: "こんにちは", context: 42 } },
  { kind: "segmentResponse", value: { choices: [{ message: { content: " 所以他的大樹又快上線了 \r\n\n再看男槍\n" } }] } },
  { kind: "segmentResponse", value: { choices: [] } },
  { kind: "segmentResponse", value: { error: { message: "nope" } } },
  { kind: "segment", body: { provider: "gemini", language: "zh", text: "所以他的大樹又快上線了", context: "有經濟差" } },
  { kind: "segment", body: { provider: "claude", language: "zh", text: "你好" } },
  // Obviously fake keys (shapes only), so secret scanners don't flag them.
  { kind: "geminiKey", value: "  AQ.fake.key.for.contract.tests.000000  " },
  { kind: "geminiKey", value: "AIza.fake.key.for.contract.tests.0000" },
  { kind: "geminiKey", value: "AQ.short" },
  { kind: "geminiKey", value: "AQ.fake.key with.a.space.000000000000" },
  { kind: "geminiKey", value: "sk-0123456789abcdefghijklmnopqrstuvwxyz" },
  { kind: "geminiKey", value: "AIzaShort" },
  { kind: "geminiTranslation", body: { targetLanguage: "zh" } },
  { kind: "geminiTranslation", body: { targetLanguage: "pt" } },
  { kind: "geminiTranslation", body: { targetLanguage: "xx" } },
  { kind: "geminiTranscription", body: {} },
  { kind: "geminiTranscription", body: { sourceLanguage: "zh", keywords: "FlyQuest\nKarsa、Vi" } },
  { kind: "geminiTranscription", body: { sourceLanguage: "xx" } },
  { kind: "geminiToken", body: { targetLanguage: "ja" } },
  { kind: "geminiTokenResponse", value: { name: "auth_tokens/abc123" } },
  { kind: "geminiTokenResponse", value: { error: { message: "nope" } } },
  { kind: "geminiSegmentResponse", value: { candidates: [{ content: { parts: [{ text: "thinking", thought: true }, { text: "所以他的大樹\r\n又快上線了\n" }, { text: "再看" }] } }] } },
  { kind: "geminiSegmentResponse", value: { candidates: [] } },
  { kind: "csp", value: null },
  { kind: "csp", value: "https://klt-relay.example.workers.dev" },
  { kind: "csp", value: "http://127.0.0.1:8788" },
];

function nodeResult(fixture) {
  try {
    if (fixture.kind === "translation") return { ok: buildTranslationSecretRequest(validateTranslationRequest(fixture.body, config), config) };
    if (fixture.kind === "transcription") return { ok: buildTranscriptionSecretRequest(validateTranscriptionRequest(fixture.body, config), config) };
    if (fixture.kind === "relayUrl") return { ok: normalizeRelayUrl(fixture.value) };
    if (fixture.kind === "publishKey") return { ok: validatePublishKey(fixture.value) };
    if (fixture.kind === "roomTitle") return { ok: normalizeRoomTitle(fixture.value) };
    if (fixture.kind === "csp") return { ok: contentSecurityPolicy(fixture.value) };
    if (fixture.kind === "segment") {
      const params = validateSegmentRequest(fixture.body, config);
      return { ok: params.provider === "gemini" ? buildGeminiSegmentRequest(params, config) : buildSegmentRequest(params, config) };
    }
    if (fixture.kind === "geminiKey") return { ok: validateGeminiKeyFormat(fixture.value) };
    if (fixture.kind === "geminiTranslation") return { ok: geminiTranslationSetup(fixture.body, config) };
    if (fixture.kind === "geminiTranscription") return { ok: geminiTranscriptionSetup(fixture.body, config) };
    if (fixture.kind === "geminiToken") return { ok: buildGeminiTokenRequest(geminiTranslationSetup(fixture.body, config), config, NOW_MS) };
    if (fixture.kind === "geminiTokenResponse") return { ok: parseGeminiToken(fixture.value) };
    if (fixture.kind === "geminiSegmentResponse") return { ok: parseGeminiSegmentResponse(fixture.value) };
    if (fixture.kind === "segmentResponse") return { ok: parseSegmentResponse(fixture.value) };
    return { ok: validateApiKeyFormat(fixture.value) };
  } catch (error) {
    if (error instanceof ValidationError) return { error: { status: error.status, message: error.message } };
    throw error;
  }
}

function swiftAvailable() {
  if (process.platform !== "darwin") return false;
  try {
    execFileSync("xcrun", ["--find", "swiftc"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("Swift (macOS app) and Node (dev server) agree on validation and payloads", { skip: !swiftAvailable() && "needs macOS + Swift" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "klt-contract-"));
  const binary = join(dir, "contract");
  execFileSync("xcrun", [
    "swiftc",
    join(root, "src/macos/RealtimeBackend.swift"),
    join(root, "src/macos/KeychainStore.swift"),
    join(root, "src/macos/TranslationSocket.swift"),
    join(root, "src/macos/SystemAudioCapture.swift"),
    join(root, "tests/macos/contract/main.swift"),
    "-o",
    binary,
  ]);
  const fixturesPath = join(dir, "fixtures.json");
  writeFileSync(fixturesPath, JSON.stringify(fixtures));
  const swift = JSON.parse(execFileSync(binary, [configPath, fixturesPath, String(NOW_MS)], { encoding: "utf8" }));
  fixtures.forEach((fixture, index) => {
    assert.deepEqual(swift[index], nodeResult(fixture), `fixture ${index}: ${JSON.stringify(fixture).slice(0, 80)}`);
  });
});
