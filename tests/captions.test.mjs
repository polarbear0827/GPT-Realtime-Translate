import assert from "node:assert/strict";
import { test } from "node:test";
import { captionLines } from "../public/js/captions.js";
import { TranscriptStore } from "../public/js/transcript.js";

const display = (text, language) => (language === "zh" ? text.replaceAll("这", "這") : text);

function sample() {
  const store = new TranscriptStore();
  store.upsertItem("a", { track: "source", language: "en", startMs: 0, transcript: "Lane, mid lane. Both very vulnerable to a Vi gank." });
  store.appendStream("translation", { track: "translation", language: "zh", delta: "下路和中路都很怕Vi來抓", atMs: 0, cjk: true });
  store.appendStream("translation", { track: "translation", language: "zh", delta: "这也有很多爆發傷害和控制", atMs: 2000, cjk: true });
  return store;
}

test("each phrase is its own line, split further at sentence ends and commas (not after a short piece)", () => {
  const store = sample();
  assert.deepEqual(captionLines(store, "translation", { display }), ["下路和中路都很怕Vi來抓", "這也有很多爆發傷害和控制"]);
  assert.deepEqual(captionLines(store, "source", { display }), ["Lane, mid lane.", "Both very vulnerable to a Vi gank."]);
});

test("only the newest lines are returned, oldest first", () => {
  const store = new TranscriptStore();
  for (let index = 0; index < 20; index += 1) {
    store.appendStream("translation", { track: "translation", language: "zh", delta: `第${index}句。`, atMs: index * 100, cjk: true });
  }
  store.sealStream("translation");
  const lines = captionLines(store, "translation", { display, limit: 3 });
  assert.deepEqual(lines, ["第17句。", "第18句。", "第19句。"]);
});

test("cleared lines stay hidden; new phrases appear", () => {
  const store = sample();
  const from = store.nextId;
  assert.deepEqual(captionLines(store, "translation", { from, display }), []);
  store.appendStream("translation", { track: "translation", language: "zh", delta: "新的一句", atMs: 5000, cjk: true });
  assert.deepEqual(captionLines(store, "translation", { from, display }), ["新的一句"]);
});

test("a line break replaces a trailing comma; Chinese gets full-width punctuation", async () => {
  const { displayText } = await import("../public/js/zh.js");
  const store = new TranscriptStore();
  store.appendStream("translation", { track: "translation", language: "zh", delta: "這局裡有很多工具和英雄,能直接秒掉Quad,", atMs: 0, cjk: true, assisted: true });
  assert.deepEqual(captionLines(store, "translation", { display: displayText }), ["這局裡有很多工具和英雄", "能直接秒掉Quad"]);
});
