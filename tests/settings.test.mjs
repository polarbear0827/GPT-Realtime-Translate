import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS, loadSettings, saveSetting } from "../public/js/settings.js";

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { get: (key) => map.get(key) ?? null, set: (key, value) => map.set(key, value), remove: (key) => map.delete(key), map };
}

test("v0.3 settings keep working", () => {
  const storage = memoryStorage({ "keynote:captionMode": "zh", "keynote:splitRatio": "0.6", "keynote:sourceFontSize": "52" });
  const settings = loadSettings(storage);
  assert.equal(settings.captionMode, "translation");
  assert.equal(settings.splitRatio, 0.6);
  assert.equal(settings.sourceFontSize, 52);
  assert.equal(settings.recording, true);
});

test("invalid values fall back to defaults or are clamped", () => {
  const storage = memoryStorage({ "keynote:captionMode": "weird", "keynote:splitRatio": "5", "keynote:translatedFontSize": "abc" });
  const settings = loadSettings(storage);
  assert.equal(settings.captionMode, DEFAULT_SETTINGS.captionMode);
  assert.equal(settings.splitRatio, 0.78);
  assert.equal(settings.translatedFontSize, DEFAULT_SETTINGS.translatedFontSize);
});

test("v0.4 caption background 'dark' becomes 'theme'; new settings have safe defaults", () => {
  const settings = loadSettings(memoryStorage({ "keynote:displayBackground": "dark" }));
  assert.equal(settings.displayBackground, "theme");
  assert.equal(settings.theme, "system");
  assert.equal(settings.audioSource, "mic");
  assert.equal(loadSettings(memoryStorage({ "keynote:audioSource": "speaker" })).audioSource, "mic");
});

test("booleans round trip", () => {
  const storage = memoryStorage();
  saveSetting("autoBackup", false, storage);
  assert.equal(loadSettings(storage).autoBackup, false);
});
