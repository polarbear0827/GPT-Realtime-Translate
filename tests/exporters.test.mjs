import assert from "node:assert/strict";
import { test } from "node:test";
import { alignGroups, exportJson, exportMarkdown, exportSrt, exportText } from "../public/js/exporters.js";
import { TranscriptStore } from "../public/js/transcript.js";

const config = { en: { label: "English", cjk: false }, zh: { label: "中文", cjk: true } };
const options = {
  display: (text) => text,
  languageInfo: (code) => ({ ...config[code], short: code.toUpperCase(), lang: code }),
  offsetMs: 0,
};

function parseSrt(text) {
  return text
    .trim()
    .split("\n\n")
    .map((block) => {
      const [index, timing, ...lines] = block.split("\n");
      const [start, end] = timing.split(" --> ").map((value) => {
        const [h, m, rest] = value.split(":");
        const [s, ms] = rest.split(",");
        return ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(ms);
      });
      return { index: Number(index), start, end, lines };
    });
}

test("one minute of continuous speech becomes subtitle-sized cues (v0.3 produced one 59 s cue)", () => {
  const store = new TranscriptStore();
  for (let index = 0; index < 60; index += 1) {
    store.upsertItem(`i${index}`, { track: "source", language: "en", startMs: index * 1000, endMs: index * 1000 + 950, transcript: `Sentence number ${index}.` });
  }
  const cues = parseSrt(exportSrt(store, "source", options));
  assert.ok(cues.length >= 30);
  for (const cue of cues) {
    assert.ok(cue.end - cue.start <= 7000, "cue ≤ 7 s");
    assert.ok(cue.lines.length <= 2, "cue ≤ 2 lines");
    assert.ok(cue.lines.every((line) => line.length <= 42));
  }
  cues.slice(1).forEach((cue, index) => assert.ok(cue.start >= cues[index].end, "cues don't overlap"));
});

test("long utterances are split across several cues with proportional timing", () => {
  const store = new TranscriptStore();
  const text = "This is a deliberately long sentence that keeps going, with several clauses, to make sure the exporter splits it, and keeps every cue readable on screen.";
  store.upsertItem("a", { track: "source", language: "en", startMs: 0, endMs: 14_000, transcript: text });
  const cues = parseSrt(exportSrt(store, "source", options));
  assert.ok(cues.length >= 2);
  assert.equal(cues.flatMap((cue) => cue.lines).join(" "), text);
  assert.ok(cues.every((cue) => cue.end - cue.start <= 7000));
});

test("tracks without content produce no empty cues (v0.3 emitted blank translation cues)", () => {
  const store = new TranscriptStore();
  store.upsertItem("a", { track: "source", language: "en", startMs: 0, endMs: 1000, transcript: "Thank you." });
  assert.equal(exportSrt(store, "translation", options), "");
  assert.equal(parseSrt(exportSrt(store, "source", options)).length, 1);
});

test("bilingual cues pair a lagging translation with the source it belongs to", () => {
  const store = new TranscriptStore();
  store.upsertItem("a", { track: "source", language: "en", startMs: 0, endMs: 3000, transcript: "Good morning everyone." });
  store.upsertItem("b", { track: "source", language: "en", startMs: 3200, endMs: 6000, transcript: "Let's begin." });
  // Translations arrive ~1.5 s late; their times are already latency-compensated.
  store.appendStream("translation", { track: "translation", language: "zh", delta: "大家早安。", atMs: 500, cjk: true });
  store.sealStream("translation");
  store.appendStream("translation", { track: "translation", language: "zh", delta: "我們開始吧。", atMs: 3600, cjk: true });
  store.sealStream("translation");
  const groups = alignGroups(store.track("source"), store.track("translation"));
  assert.deepEqual(groups.map((group) => [group.source[0].text, group.translation.map((entry) => entry.text).join("")]), [
    ["Good morning everyone.", "大家早安。"],
    ["Let's begin.", "我們開始吧。"],
  ]);
  const cues = parseSrt(exportSrt(store, "bilingual", options));
  assert.deepEqual(cues.map((cue) => cue.lines), [["Good morning everyone.", "大家早安。"], ["Let's begin.", "我們開始吧。"]]);
});

test("SRT offset shifts cues and never goes negative", () => {
  const store = new TranscriptStore();
  store.upsertItem("a", { track: "source", language: "en", startMs: 500, endMs: 2500, transcript: "Hi." });
  const [cue] = parseSrt(exportSrt(store, "source", { ...options, offsetMs: -1000 }));
  assert.equal(cue.start, 0);
  assert.equal(cue.end, 1500);
});

test("text, markdown and JSON exports", () => {
  const store = new TranscriptStore();
  store.ensureEpoch(0, Date.UTC(2026, 9, 12));
  store.upsertItem("a", { track: "source", language: "en", startMs: 0, endMs: 2000, transcript: "Hello." });
  store.appendStream("translation", { track: "translation", language: "zh", delta: "你好。", atMs: 300, cjk: true });
  store.sealStream("translation");
  assert.equal(exportText(store, options), "[00:00 - 00:02]\nEN Hello.\nZH 你好。\n");
  assert.match(exportMarkdown(store, options), /\*\*English\*\*\n\nHello\.\n\n\*\*中文\*\*\n\n你好。/);
  const json = JSON.parse(exportJson(store, { ...options, appVersion: "9.9.9" }));
  assert.equal(json.app.version, "9.9.9");
  assert.equal(json.groups[0].translation, "你好。");
});
