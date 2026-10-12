// Calls to the local backend (dev server or native host). The backend holds the API key and returns
// short-lived Realtime client secrets.

import { platform } from "./platform.js";

const REQUEST_TIMEOUT_MS = 25_000;

async function call(method, path, body) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("本機服務沒有回應，請稍後再試。")), REQUEST_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([platform.request(method, path, body), timeout]);
    const data = result?.data ?? {};
    if (!result || result.status < 200 || result.status >= 300) {
      throw new Error(errorMessage(data) || `請求失敗（${result?.status ?? "?"}）。`);
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
