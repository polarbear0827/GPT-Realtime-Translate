import assert from "node:assert/strict";
import { test } from "node:test";
import { Downsampler, GEMINI_LIVE_URL, GeminiLiveClient, Increments } from "../public/js/gemini.js";

// A WebSocket the test plays the server for.
let sockets = [];
class FakeSocket {
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.readyState = 0;
    sockets.push(this);
    setImmediate(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  receive(message, { binary = false } = {}) {
    const text = JSON.stringify(message);
    this.onmessage?.({ data: binary ? new TextEncoder().encode(text).buffer : text });
  }
  close(code) {
    this.readyState = 3;
    this.closedWith = code;
  }
  serverClose(reason) {
    this.readyState = 3;
    this.onclose?.({ code: 1008, reason });
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function connected(kind, options = {}) {
  sockets = [];
  const events = [];
  const states = [];
  const played = [];
  const client = new GeminiLiveClient(
    { kind, onEvent: (event) => events.push(event), onState: (state, message) => states.push([state, message]), ...options },
    { WebSocket: FakeSocket, createPlayer: () => ({ start: async () => {}, push: (data) => played.push(data), close() {} }) },
  );
  const setup = { model: "models/test", generationConfig: { responseModalities: ["TEXT"] } };
  const connecting = client.connect({ token: "auth_tokens/abc", setup });
  await tick();
  const socket = sockets[0];
  socket.receive({ setupComplete: {} }, { binary: true });
  await connecting;
  return { client, socket, events, states, played, setup };
}

const tone = (frequency, samples, rate = 24000, amplitude = 0.5) =>
  Int16Array.from({ length: samples }, (_, index) => Math.round(Math.sin((2 * Math.PI * frequency * index) / rate) * amplitude * 32767));

test("connects with the ephemeral token and sends the backend's setup first", async () => {
  const { socket, setup, states } = await connected("translate");
  assert.equal(socket.url, `${GEMINI_LIVE_URL}?access_token=auth_tokens/abc`);
  assert.ok(socket.url.includes("v1beta.GenerativeService.BidiGenerateContentConstrained"));
  assert.deepEqual(socket.sent[0], { setup });
  assert.deepEqual(states.at(-1), ["live", undefined]);
});

test("a refused connection rejects with the service's reason", async () => {
  sockets = [];
  const client = new GeminiLiveClient({ kind: "translate" }, { WebSocket: FakeSocket });
  const connecting = client.connect({ token: "auth_tokens/x", setup: {} });
  await tick();
  sockets[0].serverClose("API key expired");
  await assert.rejects(connecting, /API key expired/);
});

test("24 kHz audio goes out as 16 kHz, 100 ms per message", async () => {
  const { client, socket } = await connected("translate");
  client.append(tone(440, 1200).buffer);
  assert.equal(socket.sent.length, 1, "50 ms is buffered");
  client.append(tone(440, 1200).buffer);
  const audio = socket.sent[1].realtimeInput.audio;
  assert.equal(audio.mimeType, "audio/pcm;rate=16000");
  assert.equal(Buffer.from(audio.data, "base64").length, 1600 * 2);
  client.setAudioEnabled(false);
  client.append(tone(440, 1200).buffer);
  client.append(tone(440, 1200).buffer);
  assert.equal(socket.sent.length, 2, "muted while a replacement session warms up");
});

test("the downsampler keeps speech frequencies and filters what 16 kHz can't carry", () => {
  const crossings = (samples) => samples.slice(1).filter((value, index) => (samples[index] < 0) !== (value < 0)).length;
  const peak = (samples) => Math.max(...samples.slice(200).map(Math.abs)) / 32767;
  const downsampler = new Downsampler();
  const out = [];
  for (let chunk = 0; chunk < 4; chunk += 1) out.push(...downsampler.process(tone(1000, 1200).subarray(0)));
  assert.equal(out.length, 3200, "2 of every 3 samples");
  assert.ok(Math.abs(crossings(out) - 400) <= 4, `1 kHz stays 1 kHz (${crossings(out)} zero crossings in 0.2 s)`);
  assert.ok(peak(out) > 0.45, `level kept (${peak(out)})`);
  const high = new Downsampler();
  const aliased = [];
  for (let chunk = 0; chunk < 4; chunk += 1) aliased.push(...high.process(tone(10000, 1200)));
  assert.ok(peak(aliased) < 0.15, `10 kHz is filtered (${peak(aliased)})`);
});

test("translation: what was said and the translation arrive as appended text", async () => {
  const { socket, events } = await connected("translate");
  socket.receive({ serverContent: { inputTranscription: { text: "They do make" } } });
  socket.receive({ serverContent: { inputTranscription: { text: " the call" } } });
  socket.receive({ serverContent: { outputTranscription: { text: "他們決定" } } });
  socket.receive({ serverContent: { outputTranscription: { text: "不要往前衝" } } });
  assert.deepEqual(events, [
    { type: "input-delta", delta: "They do make" },
    { type: "input-delta", delta: " the call" },
    { type: "output-delta", delta: "他們決定" },
    { type: "output-delta", delta: "不要往前衝" },
  ]);
});

test("cumulative transcripts are turned into the new part only", () => {
  const increments = new Increments();
  assert.deepEqual(["他們決定", "他們決定不要", "他們決定不要往前衝"].map((text) => increments.next(text)), ["他們決定", "不要", "往前衝"]);
  increments.reset();
  assert.equal(increments.next("好"), "好");
});

test("translated speech is played only when asked", async () => {
  const silent = await connected("translate");
  silent.socket.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "AAAA" } }] } } });
  assert.equal(silent.played.length, 0);
  const loud = await connected("translate", { playAudio: true });
  loud.socket.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "AAAA" } }] } } });
  assert.deepEqual(loud.played, ["AAAA"]);
});

test("transcription: interim hypotheses replace each other; a final ends the utterance", async () => {
  const { client, socket, events } = await connected("transcribe");
  socket.receive({ serverContent: { interimInputTranscription: { text: "We already" } } });
  socket.receive({ serverContent: { interimInputTranscription: { text: "We already know what" } } });
  assert.equal(client.commit({ startPerf: 0, endPerf: 1000 }), true);
  assert.deepEqual(socket.sent.at(-1), { realtimeInput: { audioStreamEnd: true } }, "hybrid VAD: our VAD heard the speaker stop");
  socket.receive({ serverContent: { inputTranscription: { text: "We already know what Jarvan can do." } } });
  socket.receive({ serverContent: { interimInputTranscription: { text: "We already know what Jarvan can do. If Karsa" } } });
  socket.receive({ serverContent: { inputTranscription: { text: "If Karsa starts to come online." } } });
  assert.deepEqual(events, [
    { type: "partial", itemId: "gemini-0", text: "We already" },
    { type: "partial", itemId: "gemini-0", text: "We already know what" },
    { type: "committed", itemId: "gemini-0", turn: { startPerf: 0, endPerf: 1000 } },
    { type: "completed", itemId: "gemini-0", transcript: "We already know what Jarvan can do." },
    { type: "partial", itemId: "gemini-1", text: "If Karsa" },
    { type: "completed", itemId: "gemini-1", transcript: "If Karsa starts to come online." },
  ]);
});

test("goAway asks for a new connection; a dropped one is reported", async () => {
  const { socket, states } = await connected("translate");
  socket.receive({ goAway: { timeLeft: "50s" } });
  assert.deepEqual(states.at(-1), ["expiring", undefined]);
  socket.serverClose("Deadline exceeded");
  assert.equal(states.at(-1)[0], "failed");
  assert.match(states.at(-1)[1], /Deadline exceeded/);
});

test("a graceful close ends the audio and waits for the last transcript", async () => {
  const { client, socket, states } = await connected("transcribe");
  socket.receive({ serverContent: { interimInputTranscription: { text: "last words" } } });
  const closing = client.close({ graceful: true });
  await tick();
  assert.deepEqual(socket.sent.at(-1), { realtimeInput: { audioStreamEnd: true } });
  assert.equal(socket.closedWith, undefined, "still open for the final transcript");
  socket.receive({ serverContent: { inputTranscription: { text: "last words." } } });
  await closing;
  assert.equal(socket.closedWith, 1000);
  assert.ok(!states.some(([state]) => state === "failed"));
});
