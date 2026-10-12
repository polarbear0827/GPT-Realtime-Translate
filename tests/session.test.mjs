import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { LiveTrack } from "../public/js/captions.js";
import { SessionController } from "../public/js/session.js";
import { TranscriptStore } from "../public/js/transcript.js";

// Fakes for the microphone, the two Realtime clients and the backend API.
let audios;
let translates;
let transcribes;
let gates;
let controllers = [];

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

function setup(overrides = {}) {
  const store = new TranscriptStore();
  const notices = [];
  const api = {
    createTranslationSecret: async () => {
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
      liveSource: new LiveTrack(),
      liveTranslation: new LiveTrack(),
      isRecording: () => true,
      languageInfo: (code) => ({ cjk: code === "zh" }),
      onChange: () => {},
      onCaptions: () => {},
      onNotice: (level, message) => notices.push({ level, message }),
      onLevel: () => {},
    },
    { api, AudioInput: FakeAudio, TranslateClient: FakeTranslate, TranscribeClient: FakeTranscribe, delay: async () => {}, ...overrides },
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
