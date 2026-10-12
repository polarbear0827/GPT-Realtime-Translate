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

test("long streams without punctuation are capped at a clause boundary", () => {
  const store = new TranscriptStore();
  const text = `${"一".repeat(40)}，${"二".repeat(50)}`;
  for (const char of text) store.appendStream("translation", { track: "translation", language: "zh", delta: char, atMs: 0, cjk: true });
  const entries = texts(store, "translation");
  assert.equal(entries[0], `${"一".repeat(40)}，`);
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
