// Calls to the local backend (dev server or native host). The backend holds the API keys and returns
// short-lived Realtime client secrets (OpenAI) or single-use ephemeral tokens (Gemini).

import { platform } from "./platform.js";

const REQUEST_TIMEOUT_MS = 25_000;
// A line break that arrives later than this is no longer useful on screen.
const SEGMENT_TIMEOUT_MS = 8_000;

async function call(method, path, body, timeoutMs = REQUEST_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("本機服務沒有回應，請稍後再試。")), timeoutMs);
  });
  try {
    const result = await Promise.race([platform.request(method, path, body), timeout]);
    const data = result?.data ?? {};
    if (!result || result.status < 200 || result.status >= 300) {
      const error = new Error(errorMessage(data) || `請求失敗（${result?.status ?? "?"}）。`);
      error.status = result?.status ?? 0;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export function errorMessage(data) {
  const error = data?.error;
  return typeof error === "string" ? error : error?.message || "";
}

function extractToken(data) {
  const token = data?.value || data?.client_secret?.value;
  if (!token) throw new Error("OpenAI 沒有回傳連線權杖。");
  return token;
}

export const getHealth = () => call("GET", "/api/health");
export const saveKey = (apiKey, remember) => call("POST", "/api/key", { apiKey, remember: Boolean(remember) });
export const deleteKey = () => call("DELETE", "/api/key");

export async function createTranslationSecret({ targetLanguage, noiseReduction }) {
  return extractToken(await call("POST", "/api/realtime/translation-client-secret", { targetLanguage, noiseReduction }));
}

export async function createTranscriptionSecret({ sourceLanguage, delay, prompt, keywords, noiseReduction }) {
  return extractToken(
    await call("POST", "/api/realtime/transcription-client-secret", { sourceLanguage, delay, prompt, keywords, noiseReduction }),
  );
}

// Gemini: { token, setup } for one Live API session (see gemini.js).
export const saveGeminiKey = (apiKey, remember) => call("POST", "/api/gemini/key", { apiKey, remember: Boolean(remember) });
export const deleteGeminiKey = () => call("DELETE", "/api/gemini/key");
export const createGeminiTranslationToken = ({ targetLanguage }) => call("POST", "/api/gemini/translation-token", { targetLanguage });
export const createGeminiTranscriptionToken = ({ sourceLanguage, keywords }) =>
  call("POST", "/api/gemini/transcription-token", { sourceLanguage, keywords });

// Semantic line breaks: the model's lines for the open phrase of a caption stream (see segmenter.js).
export async function segmentText({ text, language, context, provider = "openai" }) {
  const data = await call("POST", "/api/segment", { text, language, context, provider }, SEGMENT_TIMEOUT_MS);
  return Array.isArray(data.lines) ? data.lines.filter((line) => typeof line === "string") : [];
}

// Audience sharing (relay settings live in the backend, like the API key).
export const saveShareConfig = (url, key) => call("POST", "/api/share/config", { url, key });
export const deleteShareConfig = () => call("DELETE", "/api/share/config");
export const createShareRoom = (title) => call("POST", "/api/share/rooms", { title });
