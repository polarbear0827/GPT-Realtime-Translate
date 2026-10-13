import assert from "node:assert/strict";
import { test } from "node:test";
import { TranscriptStore } from "../public/js/transcript.js";

const texts = (store, track) => store.track(track).map((entry) => entry.text);

test("repeated deltas are kept (v0.3 dropped 謝謝 → 謝, 100% → 10%)", () => {
  for (const deltas of [["謝", "謝", "大家"], ["我們來看", "看"], ["成長", "10", "0", "%"], ["哈", "哈", "哈"]]) {
    const store = new TranscriptStore();
    for (const delta of deltas) store.appendStream("translation", { track: "translation", language: "zh", delta, atMs: 0, cjk: true });
    store.sealStream("translation");
    assert.deepEqual(texts(store, "translation"), [deltas.join("")]);
  }
});

test("completed transcripts replace only their own item (v0.3 duplicated earlier segments)", () => {
  const store = new TranscriptStore();
  const sentences = ["Hello everyone.", "Today we launch a new product.", "It is fast."];
  sentences.forEach((sentence, index) => {
    store.upsertItem(`item${index}`, { track: "source", language: "en", startMs: index * 3000, delta: sentence.slice(0, 5) });
    store.upsertItem(`item${index}`, { track: "source", language: "en", delta: sentence.slice(5) });
    store.upsertItem(`item${index}`, { track: "source", language: "en", endMs: index * 3000 + 2500, transcript: sentence });
  });
  assert.deepEqual(texts(store, "source"), sentences);
  assert.deepEqual(store.track("source").map((entry) => [entry.startMs, entry.endMs]), [[0, 2500], [3000, 5500], [6000, 8500]]);
});

test("streamed translation is split into sentences; a sentence ends when its terminator arrived", () => {
  const store = new TranscriptStore();
  const feed = (delta, atMs) => store.appendStream("translation", { track: "translation", language: "zh", delta, atMs, cjk: true });
  feed("今天", 1000);
  feed("很好。", 1500);
  feed("明天", 6000);
  feed("見。", 6500);
  store.sealStream("translation");
  const entries = store.track("translation");
  assert.deepEqual(entries.map((entry) => entry.text), ["今天很好。", "明天見。"]);
  assert.deepEqual(entries.map((entry) => [entry.startMs, entry.endMs]), [[1000, 1500], [6000, 6500]]);
});

test("decimals don't split sentences", () => {
  const store = new TranscriptStore();
  for (const delta of ["Pi is 3", ".", "14", " exactly."]) {
    store.appendStream("translation", { track: "translation", language: "en", delta, atMs: 0, cjk: false });
  }
  store.sealStream("translation");
  assert.deepEqual(texts(store, "translation"), ["Pi is 3.14 exactly."]);
});

test("without the language model, clause marks end phrases and long ones are cut at a natural point", () => {
  const store = new TranscriptStore();
  const text = "這局裡有很多工具,能直接秒掉Quad,這就是其中之一儘管前期人頭一直往下掉所以他的大樹又快上線了再看男槍";
  for (const char of text) store.appendStream("translation", { track: "translation", language: "zh", delta: char, atMs: 0, cjk: true });
  store.sealStream("translation");
  assert.deepEqual(texts(store, "translation"), ["這局裡有很多工具,", "能直接秒掉Quad,", "這就是其中之一", "儘管前期人頭一直往下掉", "所以他的大樹又快上線了再看男槍"]);
});

test("with the language model, commas still end lines; the rest is left to it unless it's too slow", () => {
  const store = new TranscriptStore();
  const feed = (text) => {
    for (const char of text) store.appendStream("translation", { track: "translation", language: "zh", delta: char, atMs: 0, cjk: true, assisted: true });
  };
  feed("這局裡有很多工具,能直接秒掉Quad,這就是其中之一");
  assert.deepEqual(texts(store, "translation"), ["這局裡有很多工具,", "能直接秒掉Quad,", "這就是其中之一"]);
  feed("儘管前期人頭一直往下掉所以他的大樹又快上線了");
  assert.deepEqual(texts(store, "translation").slice(2), ["這就是其中之一儘管前期人頭一直往下掉所以他的大樹又快上線了"], "the model's job");
  feed("再看男槍和阿卡麗都能衝進後排");
  assert.deepEqual(texts(store, "translation").slice(2, 4), ["這就是其中之一", "儘管前期人頭一直往下掉所以他的大樹又快上線了再看男槍和阿卡麗都能衝進後排"], "cut once it ran past 40");
});

test("the model's phrase breaks cut the open phrase, each line keeping the time its text arrived", () => {
  const store = new TranscriptStore();
  const feed = (delta, atMs) => store.appendStream("translation", { track: "translation", language: "zh", delta, atMs, cjk: true, assisted: true });
  feed("儘管前期人頭", 1000);
  feed("一直往下掉所以", 1400);
  feed("他的大樹", 1800);
  store.breakStream("translation", ["儘管前期人頭一直往下掉"]);
  assert.deepEqual(store.track("translation").map((entry) => [entry.text, entry.startMs, entry.endMs, entry.final]), [
    ["儘管前期人頭一直往下掉", 1000, 1400, true],
    ["所以他的大樹", 1400, 1800, false],
  ]);
  store.breakStream("translation", ["儘管前期人頭"]);
  store.breakStream("translation", ["所以他的大樹"]);
  assert.equal(store.track("translation").length, 2, "stale or whole-phrase breaks are ignored");
  store.appendStream("translation", { track: "translation", language: "en", delta: "if he comes online this", atMs: 2000, cjk: false, assisted: true });
  store.breakStream("translation", ["所以他的大樹", "if he comes online"]);
  assert.deepEqual(texts(store, "translation").slice(-2), ["if he comes online", "this"]);
});

test("a pause in the speech starts a new phrase, even without punctuation", () => {
  const store = new TranscriptStore();
  const feed = (delta, atMs) => store.appendStream("translation", { track: "translation", language: "zh", delta, atMs, cjk: true });
  feed("下路和中路", 0);
  feed("都很怕FlyQuest的Vi來抓", 300);
  feed("他們也有很多爆發傷害", 1400);
  feed("WE那邊的", 3000);
  feed("路線組合也都很足", 3200);
  store.sealStream("translation");
  assert.deepEqual(texts(store, "translation"), ["下路和中路都很怕FlyQuest的Vi來抓", "他們也有很多爆發傷害", "WE那邊的路線組合也都很足"]);
  assert.deepEqual(store.track("translation").map((entry) => entry.startMs), [0, 1400, 3000]);
});

test("a pause after only a word or two doesn't split", () => {
  const store = new TranscriptStore();
  store.appendStream("translation", { track: "translation", language: "zh", delta: "對", atMs: 0, cjk: true });
  store.appendStream("translation", { track: "translation", language: "zh", delta: "這就是重點", atMs: 2000, cjk: true });
  store.appendStream("translation", { track: "translation", language: "en", delta: "So", atMs: 0, cjk: false });
  store.sealStream("translation");
  assert.deepEqual(texts(store, "translation"), ["對這就是重點So"]);
});

test("long English phrases are cut at a word boundary", () => {
  const store = new TranscriptStore();
  const words = Array.from({ length: 60 }, (_, index) => `word${index}`);
  for (const word of words) store.appendStream("translation", { track: "translation", language: "en", delta: `${word} `, atMs: 0, cjk: false });
  store.sealStream("translation");
  const entries = texts(store, "translation");
  assert.ok(entries.length > 1);
  assert.ok(entries.every((entry) => entry.length <= 150 && /^word\d+( word\d+)*$/.test(entry)), entries.join(" | "));
});

test("empty completed items are removed and unsaved state is tracked", () => {
  const store = new TranscriptStore();
  assert.equal(store.hasUnsavedChanges, false);
  store.upsertItem("a", { track: "source", language: "en", startMs: 0, delta: "Hi" });
  assert.equal(store.hasUnsavedChanges, true);
  store.markSaved();
  assert.equal(store.hasUnsavedChanges, false);
  store.upsertItem("b", { track: "source", language: "en", startMs: 0, transcript: "" });
  assert.equal(store.track("source").length, 1);
});

test("backup round trip continues the timeline", () => {
  const store = new TranscriptStore();
  store.ensureEpoch(1000);
  store.upsertItem("a", { track: "source", language: "en", startMs: 0, endMs: 4000, transcript: "Hello." });
  const restored = new TranscriptStore();
  assert.equal(restored.restore(JSON.parse(JSON.stringify(store.toJSON())), 50_000), true);
  assert.deepEqual(texts(restored, "source"), ["Hello."]);
  assert.ok(restored.relative(50_000) > 4000, "new entries are placed after the restored ones");
  assert.equal(restored.hasUnsavedChanges, true);
});
