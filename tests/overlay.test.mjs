import assert from "node:assert/strict";
import { test } from "node:test";
import { buildOverlayPayload } from "../public/js/overlay.js";

const languageInfo = (code) => ({ cjk: code === "zh" || code === "ja", lang: code === "zh" ? "zh-Hant" : code });
const base = { languageInfo, display: (text, language) => (language === "zh" ? text.replace("软件", "軟體") : text) };

test("translation is the main line and the original sits below it", () => {
  const payload = buildOverlayPayload({
    ...base,
    mode: "bilingual",
    sourceText: "안녕하세요. 오늘 날씨가 좋네요.",
    translationText: "你好。今天天氣很好。新的软件",
    sourceLanguage: "ko",
    targetLanguage: "zh",
  });
  assert.deepEqual(payload.primary, { sentences: ["你好。", "今天天氣很好。", "新的軟體"], cjk: true, lang: "zh-Hant" });
  assert.deepEqual(payload.secondary.sentences, ["안녕하세요.", "오늘 날씨가 좋네요."]);
});

test("only the latest sentences are sent", () => {
  const text = Array.from({ length: 10 }, (_, index) => `Sentence ${index}.`).join(" ");
  const payload = buildOverlayPayload({ ...base, mode: "translation", sourceText: "", translationText: text, sourceLanguage: "ko", targetLanguage: "en" });
  assert.deepEqual(payload.primary.sentences, ["Sentence 6.", "Sentence 7.", "Sentence 8.", "Sentence 9."]);
  assert.equal(payload.secondary, null, "no original line when there is no source text");
});

test("source-only mode shows the source as the main line", () => {
  const payload = buildOverlayPayload({ ...base, mode: "source", sourceText: "Hello there.", translationText: "你好。", sourceLanguage: "en", targetLanguage: "zh" });
  assert.deepEqual(payload.primary.sentences, ["Hello there."]);
  assert.equal(payload.secondary, null);
});
