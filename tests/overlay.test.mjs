import assert from "node:assert/strict";
import { test } from "node:test";
import { buildOverlayPayload } from "../public/js/overlay.js";

const zh = { cjk: true, lang: "zh-Hant" };
const ko = { cjk: false, lang: "ko" };
const en = { cjk: false, lang: "en" };

test("translation lines are the main text and the original sits below them", () => {
  const payload = buildOverlayPayload({
    mode: "bilingual",
    sourceLines: ["안녕하세요.", "오늘 날씨가 좋네요."],
    translationLines: ["你好。", "今天天氣很好", "新的軟體"],
    sourceInfo: ko,
    targetInfo: zh,
  });
  assert.deepEqual(payload.primary, { sentences: ["你好。", "今天天氣很好", "新的軟體"], cjk: true, lang: "zh-Hant" });
  assert.deepEqual(payload.secondary, { sentences: ["안녕하세요.", "오늘 날씨가 좋네요."], cjk: false, lang: "ko" });
});

test("no original line when there is no source text", () => {
  const payload = buildOverlayPayload({ mode: "translation", sourceLines: [], translationLines: ["Hi."], sourceInfo: ko, targetInfo: en });
  assert.equal(payload.secondary, null);
});

test("source-only mode shows the source as the main text", () => {
  const payload = buildOverlayPayload({ mode: "source", sourceLines: ["Hello there."], translationLines: ["你好。"], sourceInfo: en, targetInfo: zh });
  assert.deepEqual(payload.primary.sentences, ["Hello there."]);
  assert.equal(payload.secondary, null);
});
