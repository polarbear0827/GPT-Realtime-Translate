// Persisted UI settings (localStorage, one key per setting: "keynote:<name>").
// Values are stored as plain strings so settings saved by v0.3 keep working.

const PREFIX = "keynote:";

export const DEFAULT_SETTINGS = {
  captionMode: "bilingual",
  sourceLanguage: "en",
  targetLanguage: "zh",
  bilingualEngine: "dual",
  splitRatio: 0.48,
  sourceFontSize: 48,
  translatedFontSize: 62,
  micDeviceId: "",
  micProcessing: "standard",
  noiseReduction: "near_field",
  transcriptionDelay: "low",
  keywords: "",
  prompt: "",
  translationLatencyMs: 1500,
  srtOffsetMs: 0,
  recording: true,
  autoBackup: true,
  playAudio: false,
  displayBackground: "dark",
  displayAlign: "left",
};

const CHOICES = {
  captionMode: ["bilingual", "translation", "source"],
  bilingualEngine: ["dual", "translate"],
  micProcessing: ["standard", "raw"],
  displayBackground: ["dark", "black", "green"],
  displayAlign: ["left", "center"],
};

const RANGES = {
  splitRatio: [0.22, 0.78],
  sourceFontSize: [20, 120],
  translatedFontSize: [20, 140],
  translationLatencyMs: [0, 5000],
  srtOffsetMs: [-10000, 10000],
};

export function loadSettings(storage = safeStorage()) {
  const settings = { ...DEFAULT_SETTINGS };
  for (const [name, fallback] of Object.entries(DEFAULT_SETTINGS)) {
    const stored = storage.get(PREFIX + name);
    if (stored === null) continue;
    settings[name] = parse(name, stored, fallback);
  }
  // v0.1 stored caption modes by language.
  if (settings.captionMode === "en") settings.captionMode = "source";
  if (settings.captionMode === "zh") settings.captionMode = "translation";
  return sanitize(settings);
}

export function saveSetting(name, value, storage = safeStorage()) {
  storage.set(PREFIX + name, String(value));
}

export function sanitize(settings) {
  const result = { ...settings };
  for (const [name, choices] of Object.entries(CHOICES)) {
    if (!choices.includes(result[name])) result[name] = DEFAULT_SETTINGS[name];
  }
  for (const [name, [min, max]] of Object.entries(RANGES)) {
    const value = Number(result[name]);
    result[name] = Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : DEFAULT_SETTINGS[name];
  }
  return result;
}

function parse(name, stored, fallback) {
  if (typeof fallback === "number") {
    const value = Number(stored);
    return Number.isFinite(value) ? value : fallback;
  }
  if (typeof fallback === "boolean") return stored === "true";
  return stored;
}

export function safeStorage() {
  return {
    get(key) {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // Storage unavailable (private mode); settings stay in memory.
      }
    },
    remove(key) {
      try {
        window.localStorage.removeItem(key);
      } catch {
        // Ignore.
      }
    },
  };
}
