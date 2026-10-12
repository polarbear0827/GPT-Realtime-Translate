// The dev server (Node) and the macOS app (Swift) implement the same validation and OpenAI payloads.
// This compiles the Swift rules and checks both produce identical results for the same fixtures.
// (The Android Java implementation follows the same rules; it is compiled in CI.)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ValidationError,
  buildTranscriptionSecretRequest,
  buildTranslationSecretRequest,
  validateApiKeyFormat,
  validateTranscriptionRequest,
  validateTranslationRequest,
} from "../server/realtime.mjs";

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
];

function nodeResult(fixture) {
  try {
    if (fixture.kind === "translation") return { ok: buildTranslationSecretRequest(validateTranslationRequest(fixture.body, config), config) };
    if (fixture.kind === "transcription") return { ok: buildTranscriptionSecretRequest(validateTranscriptionRequest(fixture.body, config), config) };
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
    join(root, "tests/macos/contract/main.swift"),
    "-o",
    binary,
  ]);
  const fixturesPath = join(dir, "fixtures.json");
  writeFileSync(fixturesPath, JSON.stringify(fixtures));
  const swift = JSON.parse(execFileSync(binary, [configPath, fixturesPath], { encoding: "utf8" }));
  fixtures.forEach((fixture, index) => {
    assert.deepEqual(swift[index], nodeResult(fixture), `fixture ${index}: ${JSON.stringify(fixture).slice(0, 80)}`);
  });
});
