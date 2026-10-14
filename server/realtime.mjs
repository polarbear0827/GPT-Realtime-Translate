// Pure request validation and OpenAI payload builders.
// The macOS app (src/macos/RealtimeBackend.swift) implements the same rules from public/realtime-config.json;
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

// Semantic line breaks: the open phrase of a live caption stream, and optionally the line before it.
export function validateSegmentRequest(body, config) {
  const language = stringOr(body?.language, "");
  if (!config.transcriptionLanguages.includes(language) && !config.translationOutputLanguages.includes(language)) {
    throw new ValidationError("不支援的語言。");
  }
  const text = stringOr(body?.text, "").trim();
  if (!text) throw new ValidationError("沒有要斷句的文字。");
  if (text.length > config.segmentation.textMaxChars) throw new ValidationError("要斷句的文字太長。");
  const context = stringOr(body?.context, "").trim();
  if (context.length > config.segmentation.contextMaxChars) throw new ValidationError("前文太長。");
  const provider = stringOr(body?.provider, "openai");
  if (!config.providers.includes(provider)) throw new ValidationError("不支援的服務商。");
  return { provider, language, text, context };
}

export function buildSegmentRequest({ text, context }, config) {
  return {
    model: config.models.segmentation,
    temperature: 0,
    max_completion_tokens: config.segmentation.maxOutputTokens,
    messages: [
      { role: "system", content: config.segmentation.instructions },
      { role: "user", content: context ? `Previous line:\n${context}\n\nText:\n${text}` : `Text:\n${text}` },
    ],
  };
}

// The model's lines (Chat Completions response). Mapping them back onto the text is the client's job.
export function parseSegmentResponse(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new ValidationError("OpenAI 回應格式錯誤。", 502);
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
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
