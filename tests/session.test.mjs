import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { SessionController } from "../public/js/session.js";
import { TranscriptStore } from "../public/js/transcript.js";

// Fakes for the microphone, the two Realtime clients and the backend API.
let audios;
let translates;
let transcribes;
let gates;
let controllers = [];
let secretRequests = { translation: 0, transcription: 0 };

class FakeAudio {
  constructor({ onChunk, onEnded }) {
    Object.assign(this, { onChunk, onEnded, closed: false });
    audios.push(this);
  }
  async open() {
    await gates.audio;
    if (this.closed) throw new DOMException("Cancelled", "AbortError");
    this.opened = true;
  }
  get track() {
    return { kind: "audio" };
  }
  close() {
    this.closed = true;
  }
}

class FakeSystemAudio extends FakeAudio {
  async open(options) {
    this.openOptions = options;
    await super.open();
  }
}

class FakeTranslate {
  constructor(options) {
    Object.assign(this, options, { closed: null, audioEnabled: null });
    translates.push(this);
  }
  async connect(secret, { audioEnabled = true } = {}) {
    this.secret = secret;
    this.audioEnabled = audioEnabled;
    if (gates.translateFails) throw new Error("translate connect failed");
    this.connected = true;
  }
  async setAudioEnabled(enabled) {
    this.audioEnabled = enabled;
  }
  setPlayAudio() {}
  async close({ graceful }) {
    this.closed = { graceful };
  }
}

class FakeNativeTranslate extends FakeTranslate {
  static get supported() {
    return true;
  }
}

class FakeTranscribe {
  constructor(options) {
    Object.assign(this, options, { closed: null, appended: 0, commits: [] });
    transcribes.push(this);
  }
  get isOpen() {
    return this.connected && !this.closed;
  }
  async connect(secret) {
    this.secret = secret;
    this.connected = true;
  }
  append() {
    this.appended += 1;
    return true;
  }
  commit(turn) {
    this.commits.push(turn);
    return true;
  }
  async close({ graceful }) {
    this.closed = { graceful };
  }
}

function setup(overrides = {}, { feed, recording = true } = {}) {
  const store = new TranscriptStore();
  const notices = [];
  const api = {
    createTranslationSecret: async () => {
      secretRequests.translation += 1;
      await gates.secrets;
      return "ek_translate";
    },
    createTranscriptionSecret: async () => {
      await gates.secrets;
      return "ek_transcribe";
    },
  };
  const controller = new SessionController(
    {
      store,
      feed,
      isRecording: () => recording,
      languageInfo: (code) => ({ cjk: code === "zh" }),
      onChange: () => {},
      onCaptions: () => {},
      onNotice: (level, message) => notices.push({ level, message }),
      onLevel: () => {},
    },
    {
      api,
      AudioInput: FakeAudio,
      SystemAudioInput: FakeSystemAudio,
      NativeTranslateClient: FakeNativeTranslate,
      TranslateClient: FakeTranslate,
      TranscribeClient: FakeTranscribe,
      delay: async () => {},
      ...overrides,
    },
  );
  controllers.push(controller);
  return { controller, store, notices };
}

const options = (mode = "bilingual", extra = {}) => ({
  mode,
  sourceLanguage: "en",
  targetLanguage: "zh",
  bilingualEngine: "dual",
  deviceId: "",
  micProcessing: "standard",
  noiseReduction: "near_field",
  transcriptionDelay: "low",
  prompt: "",
  keywords: "",
  translationLatencyMs: 1500,
  playAudio: false,
  ...extra,
});

// Always stop every controller, even when an assertion failed mid-test: a live session keeps a
// timer running, which would otherwise keep the test process alive forever.
afterEach(async () => {
  await Promise.all(controllers.map((controller) => controller.stop()));
  controllers = [];
});

beforeEach(() => {
  secretRequests = { translation: 0, transcription: 0 };
  audios = [];
  translates = [];
  transcribes = [];
  gates = { audio: Promise.resolve(), secrets: Promise.resolve(), translateFails: false };
});

test("bilingual start connects both tracks; stop closes them gracefully", async () => {
  const { controller } = setup();
  await controller.start(options());
  assert.equal(controller.status, "live");
  assert.deepEqual(controller.connections, { transcribe: "live", translate: "live" });
  assert.equal(translates[0].secret, "ek_translate");
  assert.equal(transcribes[0].secret, "ek_transcribe");
  await controller.stop();
  assert.equal(controller.status, "idle");
  assert.deepEqual(translates[0].closed, { graceful: true });
  assert.deepEqual(transcribes[0].closed, { graceful: true });
  assert.equal(audios[0].closed, true);
});

test("each mode only opens the connections it needs", async () => {
  for (const [mode, extra, expected] of [
    ["source", {}, { transcribe: 1, translate: 0 }],
    ["translation", {}, { transcribe: 0, translate: 1 }],
    ["bilingual", { bilingualEngine: "translate" }, { transcribe: 0, translate: 1 }],
  ]) {
    translates = [];
    transcribes = [];
    const { controller } = setup();
    await controller.start(options(mode, extra));
    assert.deepEqual({ transcribe: transcribes.length, translate: translates.length }, expected, mode);
    await controller.stop();
  }
});

test("Stop during startup cancels it: nothing connects afterwards and the mic is released", async () => {
  let releaseSecrets;
  gates.secrets = new Promise((resolve) => (releaseSecrets = resolve));
  const { controller } = setup();
  const starting = controller.start(options());
  await Promise.resolve();
  assert.equal(controller.status, "starting");
  await controller.stop();
  assert.equal(controller.status, "idle");
  releaseSecrets();
  await starting;
  assert.equal(controller.status, "idle");
  assert.equal(translates.length + transcribes.length, 0, "no connection was created after Stop");
  assert.ok(audios.every((audio) => audio.closed));
});

test("a failed start tears everything down and returns to idle (Stop is never stuck disabled)", async () => {
  gates.translateFails = true;
  const { controller } = setup();
  await assert.rejects(controller.start(options()), /translate connect failed/);
  assert.equal(controller.status, "idle");
  assert.ok(transcribes.every((client) => client.closed));
  assert.ok(audios.every((audio) => audio.closed));
  gates.translateFails = false;
  await controller.start(options());
  assert.equal(controller.status, "live");
  await controller.stop();
});

test("a dropped translation connection reconnects with a fresh secret", async () => {
  const { controller, notices } = setup();
  await controller.start(options("translation"));
  translates[0].onState("failed", "network");
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(translates.length, 2);
  assert.deepEqual(translates[0].closed, { graceful: false });
  assert.equal(translates[1].connected, true);
  assert.equal(controller.connections.translate, "live");
  assert.ok(notices.some((notice) => notice.level === "success"));
  await controller.stop();
});

test("speech turns are committed by the client-side VAD", async () => {
  const { controller } = setup();
  await controller.start(options("source"));
  const audio = audios[0];
  let now = 1000;
  const feed = (rms, count) => {
    for (let index = 0; index < count; index += 1) {
      now += 50;
      audio.onChunk(new ArrayBuffer(2400), rms, rms, now);
    }
  };
  feed(0.001, 20);
  feed(0.2, 30);
  feed(0.001, 20);
  const [client] = transcribes;
  assert.equal(client.commits.length, 1);
  const [turn] = client.commits;
  assert.ok(Math.abs(turn.startPerf - 1750) <= 100, `turn start ${turn.startPerf}`);
  assert.ok(Math.abs(turn.endPerf - 3500) <= 100, `turn end ${turn.endPerf}`);
  assert.equal(client.appended, 70);
  await controller.stop();
});

test("transcription events build one transcript entry per turn with VAD timing", async () => {
  const { controller, store } = setup();
  await controller.start(options("source"));
  const [client] = transcribes;
  client.onEvent({ type: "delta", itemId: "item1", delta: "Hello " });
  client.onEvent({ type: "delta", itemId: "item1", delta: "world." });
  client.onEvent({ type: "committed", itemId: "item1", turn: { startPerf: controller.store.epochPerf + 100, endPerf: controller.store.epochPerf + 2100 } });
  client.onEvent({ type: "completed", itemId: "item1", transcript: "Hello world." });
  client.onEvent({ type: "delta", itemId: "item2", delta: "Second." });
  client.onEvent({ type: "completed", itemId: "item2", transcript: "Second." });
  const entries = store.track("source");
  assert.deepEqual(entries.map((entry) => entry.text), ["Hello world.", "Second."]);
  assert.equal(entries[0].startMs, 100);
  assert.equal(entries[0].endMs, 2100);
  await controller.stop();
});

test("translation-only mode still records the source transcript from the translation session", async () => {
  const { controller, store } = setup();
  await controller.start(options("translation"));
  translates[0].onEvent({ type: "input-delta", delta: "Hello." });
  translates[0].onEvent({ type: "output-delta", delta: "你好。" });
  await controller.stop();
  assert.deepEqual(store.track("source").map((entry) => entry.text), ["Hello."]);
  assert.deepEqual(store.track("translation").map((entry) => entry.text), ["你好。"]);
});

test("session_expired errors trigger a reconnect instead of an error state", async () => {
  const { controller } = setup();
  await controller.start(options("translation"));
  translates[0].onEvent({ type: "error", error: { code: "session_expired", message: "Your session hit the maximum duration of 60 minutes." } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(translates.length, 2);
  assert.equal(controller.status, "live");
  await controller.stop();
});

test("system audio source: uses the native capture, never plays translated speech, warns on silence", async () => {
  const { controller, notices } = setup();
  await controller.start(options("translation", { audioSource: "system", muteSystemAudio: true, playAudio: true }));
  const [audio] = audios;
  assert.ok(audio instanceof FakeSystemAudio);
  assert.equal(audio.openOptions.muteSource, true);
  assert.equal(translates[0].playAudio, false, "translated speech would be captured again");
  controller.run.liveSince -= 6000;
  controller.tick(controller.run);
  assert.ok(notices.some((notice) => notice.level === "system-audio-silent"));
  await controller.stop();
});

test("system audio with signal does not warn", async () => {
  const { controller, notices } = setup();
  await controller.start(options("translation", { audioSource: "system" }));
  audios[0].onChunk(new ArrayBuffer(2400), 0.1, 0.2, performance.now());
  controller.run.liveSince -= 6000;
  controller.tick(controller.run);
  assert.ok(!notices.some((notice) => notice.level === "system-audio-silent"));
  await controller.stop();
});

test("system audio translates over the app's own WebSocket (no WebRTC, no client secret)", async () => {
  const { controller } = setup();
  await controller.start(options("translation", { audioSource: "system" }));
  assert.ok(translates[0] instanceof FakeNativeTranslate);
  assert.equal(translates[0].targetLanguage, "zh");
  assert.equal(secretRequests.translation, 0);
  translates[0].onState("failed", "socket closed");
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(translates[1] instanceof FakeNativeTranslate, "reconnects with the native client too");
  assert.equal(secretRequests.translation, 0);
  await controller.stop();
});

test("microphone keeps using WebRTC translation", async () => {
  const { controller } = setup();
  await controller.start(options("translation"));
  assert.ok(!(translates[0] instanceof FakeNativeTranslate));
  assert.equal(secretRequests.translation, 1);
  await controller.stop();
});

test("the sharing feed gets every sentence, even when the transcript isn't recorded", async () => {
  const feed = new TranscriptStore();
  const { controller, store } = setup({}, { feed, recording: false });
  await controller.start(options());
  translates[0].onEvent({ type: "output-delta", delta: "大家好。" });
  translates[0].onEvent({ type: "output-delta", delta: "今天" });
  transcribes[0].onEvent({ type: "delta", itemId: "item1", delta: "Hello" });
  transcribes[0].onEvent({ type: "completed", itemId: "item1", transcript: "Hello everyone." });
  assert.equal(store.entries.length, 0, "not recorded");
  assert.deepEqual(
    feed.entries.map((entry) => [entry.track, entry.text, entry.final]),
    [
      ["translation", "大家好。", true],
      ["translation", "今天", false],
      ["source", "Hello everyone.", true],
    ],
  );
  await controller.stop();
  assert.ok(feed.entries.every((entry) => entry.final), "stopping seals the feed too");
});

test("smart breaks: the model's phrase breaks reach both the transcript and the live feed", async () => {
  const feed = new TranscriptStore();
  const requests = [];
  const { controller, store } = setup({}, { feed });
  controller.api.segmentText = async (body) => {
    requests.push(body);
    return body.text.split(/(?=所以)/);
  };
  await controller.start(options("translation"));
  translates[0].onEvent({ type: "output-delta", delta: "儘管前期人頭一直往下掉" });
  translates[0].onEvent({ type: "output-delta", delta: "所以他的大樹" });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  for (const target of [store, feed]) {
    assert.deepEqual(target.track("translation").map((entry) => entry.text), ["儘管前期人頭一直往下掉", "所以他的大樹"]);
  }
  assert.equal(requests[0].language, "zh");
  await controller.stop();
});

test("smart breaks can be turned off", async () => {
  const requests = [];
  const { controller } = setup();
  controller.api.segmentText = async (body) => requests.push(body);
  await controller.start(options("translation", { smartBreaks: false }));
  translates[0].onEvent({ type: "output-delta", delta: "儘管前期人頭一直往下掉所以他的大樹" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 0);
  controller.setSmartBreaks(true);
  translates[0].onEvent({ type: "output-delta", delta: "又快上線了" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1);
  await controller.stop();
});

// Gemini: same session flow, different clients and secrets.
class FakeGemini {
  constructor(options) {
    Object.assign(this, options, { closed: null, appended: [], commits: [], audioEnabled: null });
    (options.kind === "translate" ? translates : transcribes).push(this);
  }
  get isOpen() {
    return this.connected && !this.closed;
  }
  async connect(secret, { audioEnabled = true } = {}) {
    this.secret = secret;
    this.audioEnabled = audioEnabled;
    this.connected = true;
  }
  append(pcm) {
    this.appended.push(pcm);
    return true;
  }
  commit(turn) {
    this.commits.push(turn);
    return true;
  }
  setAudioEnabled(enabled) {
    this.audioEnabled = enabled;
  }
  setPlayAudio() {}
  async close({ graceful }) {
    this.closed = { graceful };
  }
}

function geminiSetup(overrides = {}, extra = {}) {
  const tokens = [];
  const result = setup({ GeminiClient: FakeGemini, ...overrides }, extra);
  Object.assign(result.controller.api, {
    createGeminiTranslationToken: async (body) => {
      tokens.push(["translate", body]);
      return { token: "auth_tokens/t", setup: { model: "models/translate" } };
    },
    createGeminiTranscriptionToken: async (body) => {
      tokens.push(["transcribe", body]);
      return { token: "auth_tokens/s", setup: { model: "models/transcribe" } };
    },
  });
  return { ...result, tokens };
}

test("Gemini: both tracks use Gemini tokens and clients, and translation gets the audio as PCM", async () => {
  const { controller, store, tokens } = geminiSetup();
  await controller.start(options("bilingual", { provider: "gemini", keywords: "FlyQuest" }));
  assert.deepEqual(tokens, [
    ["translate", { targetLanguage: "zh" }],
    ["transcribe", { sourceLanguage: "en", keywords: "FlyQuest" }],
  ]);
  assert.equal(secretRequests.translation, 0, "no OpenAI client secret");
  assert.equal(translates[0].kind, "translate");
  assert.equal(transcribes[0].kind, "transcribe");
  assert.deepEqual(translates[0].secret, { token: "auth_tokens/t", setup: { model: "models/translate" } });

  const pcm = new Int16Array(1200).buffer;
  audios[0].onChunk(pcm, 0.1, 0.2, performance.now());
  assert.equal(translates[0].appended.length, 1);
  assert.equal(transcribes[0].appended.length, 1);

  translates[0].onEvent({ type: "output-delta", delta: "大家好。" });
  transcribes[0].onEvent({ type: "partial", itemId: "gemini-0", text: "Hello" });
  transcribes[0].onEvent({ type: "partial", itemId: "gemini-0", text: "Hello every" });
  assert.deepEqual(store.track("source").map((entry) => [entry.text, entry.final]), [["Hello every", false]]);
  transcribes[0].onEvent({ type: "completed", itemId: "gemini-0", transcript: "Hello everyone." });
  assert.deepEqual(store.track("source").map((entry) => [entry.text, entry.final]), [["Hello everyone.", true]]);
  assert.deepEqual(store.track("translation").map((entry) => entry.text), ["大家好。"]);
  await controller.stop();
});

test("Gemini: system audio also goes over the WebSocket (no native OpenAI client)", async () => {
  const { controller } = geminiSetup();
  await controller.start(options("translation", { provider: "gemini", audioSource: "system" }));
  assert.ok(translates[0] instanceof FakeGemini);
  await controller.stop();
});

test("Gemini: goAway renews the connection; audio moves to the new one", async () => {
  const { controller, tokens } = geminiSetup();
  await controller.start(options("translation", { provider: "gemini" }));
  const first = translates[0];
  first.onState("expiring");
  controller.tick(controller.run);
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(tokens.filter(([kind]) => kind === "translate").length, 2);
  const second = translates[1];
  assert.equal(controller.run.translate, second);
  assert.equal(second.audioEnabled, true);
  assert.deepEqual(first.closed, { graceful: true });
  audios[0].onChunk(new Int16Array(1200).buffer, 0.1, 0.2, performance.now());
  assert.equal(second.appended.length, 1);
  assert.equal(first.appended.length, 0);
  await controller.stop();
});
