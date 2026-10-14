// Google Gemini (Live API) rules and payloads: key format, the setup of each live session, ephemeral
// token requests and the text model used for line breaks.
// The macOS app (GeminiRules in src/macos/RealtimeBackend.swift) implements the same rules from
// public/realtime-config.json; tests/contract.test.mjs keeps them in sync.

import { ValidationError, validateTranscriptionRequest, validateTranslationRequest } from "./realtime.mjs";

export const GEMINI = "https://generativelanguage.googleapis.com/v1beta";

// AI Studio creates "auth keys" (AQ.…) since May 2026; older standard keys (AIza…) still work when
// they're restricted. Both go in the x-goog-api-key header.
export function validateGeminiKeyFormat(value) {
  const key = typeof value === "string" ? value.trim() : "";
  if (!/^(AQ\.|AIza)[!-~]{20,}$/.test(key)) {
    throw new ValidationError("Gemini API key 格式不正確，應以 AQ. 開頭（舊式金鑰以 AIza 開頭）。");
  }
  return key;
}

// Translated speech plus both transcripts. Speech already in the target language is repeated
// ("echoed") so it still gets captions.
export function geminiTranslationSetup(body, config) {
  const { targetLanguage } = validateTranslationRequest(body, config);
  return {
    model: `models/${config.gemini.models.translation}`,
    generationConfig: {
      responseModalities: ["AUDIO"],
      translationConfig: { targetLanguageCode: config.gemini.languages[targetLanguage].translate, echoTargetLanguage: true },
    },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  };
}

// SMART transcription adds punctuation and drops filler words; keywords become custom vocabulary.
export function geminiTranscriptionSetup(body, config) {
  const { sourceLanguage, keywords } = validateTranscriptionRequest(body, config);
  const transcription = { languageCodes: [config.gemini.languages[sourceLanguage].transcribe], mode: "SMART" };
  if (keywords.length > 0) transcription.customVocabulary = keywords;
  return {
    model: `models/${config.gemini.models.transcription}`,
    generationConfig: { responseModalities: ["TEXT"] },
    inputAudioTranscription: transcription,
  };
}

// A single-use token locked to this exact setup: the page can open one session with it and change
// nothing (POST /v1beta/auth_tokens).
export function buildGeminiTokenRequest(setup, config, nowMs) {
  return {
    uses: 1,
    expireTime: new Date(nowMs + config.gemini.tokenTtlSeconds * 1000).toISOString(),
    newSessionExpireTime: new Date(nowMs + config.gemini.newSessionSeconds * 1000).toISOString(),
    bidiGenerateContentSetup: setup,
  };
}

export function parseGeminiToken(data) {
  const token = data?.name;
  if (typeof token !== "string" || !token.startsWith("auth_tokens/")) throw new ValidationError("Gemini 沒有回傳連線權杖。", 502);
  return token;
}

// Same prompt as the OpenAI request (see buildSegmentRequest), for gemini-3.5-flash-lite.
export function buildGeminiSegmentRequest({ text, context }, config) {
  return {
    systemInstruction: { parts: [{ text: config.segmentation.instructions }] },
    contents: [{ role: "user", parts: [{ text: context ? `Previous line:\n${context}\n\nText:\n${text}` : `Text:\n${text}` }] }],
    generationConfig: { maxOutputTokens: 1024 },
  };
}

export function parseGeminiSegmentResponse(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) throw new ValidationError("Gemini 回應格式錯誤。", 502);
  return parts
    .filter((part) => typeof part?.text === "string" && !part.thought)
    .map((part) => part.text)
    .join("")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}
