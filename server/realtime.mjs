// Pure request validation and OpenAI payload builders.
// The macOS (Swift) and Android (Java) backends implement the same rules from public/realtime-config.json;
// tests/contract.test.mjs keeps them in sync.

export class ValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function validateApiKeyFormat(value) {
  const key = typeof value === "string" ? value.trim() : "";
  if (!key.startsWith("sk-") || key.length < 20 || /\s/.test(key)) {
    throw new ValidationError("API key 格式不正確，應以 sk- 開頭。");
  }
  return key;
}

export function validateTranslationRequest(body, config) {
  const targetLanguage = stringOr(body?.targetLanguage, config.defaults.targetLanguage);
  if (!config.translationOutputLanguages.includes(targetLanguage)) {
    throw new ValidationError("不支援的翻譯目標語言。");
  }
  return { targetLanguage, noiseReduction: validateNoiseReduction(body?.noiseReduction, config) };
}

export function validateTranscriptionRequest(body, config) {
  const sourceLanguage = stringOr(body?.sourceLanguage, config.defaults.sourceLanguage);
  if (!config.transcriptionLanguages.includes(sourceLanguage)) {
    throw new ValidationError("不支援的原文語言。");
  }
  const delay = stringOr(body?.delay, config.defaults.transcriptionDelay);
  if (!config.transcriptionDelays.includes(delay)) {
    throw new ValidationError("不支援的轉錄延遲設定。");
  }
  const prompt = stringOr(body?.prompt, "").trim();
  if (prompt.length > config.limits.promptMaxChars) {
    throw new ValidationError(`情境說明最多 ${config.limits.promptMaxChars} 個字。`);
  }
  return {
    sourceLanguage,
    delay,
    prompt,
    keywords: normalizeKeywords(body?.keywords, config),
    noiseReduction: validateNoiseReduction(body?.noiseReduction, config),
  };
}

// Keywords may arrive as an array or as newline/comma separated text. The API rejects keywords that
// contain "<", ">" or line breaks, so those characters are removed rather than failing the session.
export function normalizeKeywords(input, config) {
  const raw = Array.isArray(input) ? input : typeof input === "string" ? input.split(/[\n,，、]/) : [];
  const seen = new Set();
  const keywords = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const keyword = item.replace(/[<>\r\n]/g, " ").replace(/\s+/g, " ").trim();
    if (!keyword || seen.has(keyword.toLowerCase())) continue;
    if (keyword.length > config.limits.keywordMaxChars) {
      throw new ValidationError(`關鍵字「${keyword.slice(0, 20)}…」太長，每個最多 ${config.limits.keywordMaxChars} 字。`);
    }
    seen.add(keyword.toLowerCase());
    keywords.push(keyword);
  }
  if (keywords.length > config.limits.keywordsMaxCount) {
    throw new ValidationError(`關鍵字最多 ${config.limits.keywordsMaxCount} 個。`);
  }
  return keywords;
}

export function buildTranslationSecretRequest({ targetLanguage, noiseReduction }, config) {
  return {
    session: {
      model: config.models.translation,
      audio: {
        input: { noise_reduction: { type: noiseReduction } },
        output: { language: targetLanguage },
      },
    },
  };
}

export function buildTranscriptionSecretRequest({ sourceLanguage, delay, prompt, keywords, noiseReduction }, config) {
  const transcription = {
    model: config.models.transcription,
    languages: [sourceLanguage],
    delay,
  };
  if (prompt) transcription.prompt = prompt;
  if (keywords.length > 0) transcription.keywords = keywords;
  return {
    expires_after: { anchor: "created_at", seconds: config.clientSecretTtlSeconds },
    session: {
      type: "transcription",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24000 },
          transcription,
          noise_reduction: { type: noiseReduction },
          turn_detection: null,
        },
      },
    },
  };
}

function validateNoiseReduction(value, config) {
  const type = stringOr(value, config.defaults.noiseReduction);
  if (!config.noiseReductionTypes.includes(type)) {
    throw new ValidationError("不支援的降噪設定。");
  }
  return type;
}

function stringOr(value, fallback) {
  return typeof value === "string" && value !== "" ? value : fallback;
}
