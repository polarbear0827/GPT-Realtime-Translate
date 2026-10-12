import assert from "node:assert/strict";
import { test } from "node:test";
import { CHUNK_SAMPLES, PcmChunker } from "../public/js/pcm-processor.js";
import { VoiceActivityDetector } from "../public/js/vad.js";

function sine(rate, frequency, seconds, amplitude = 0.5) {
  return Float32Array.from({ length: Math.round(rate * seconds) }, (_, index) => amplitude * Math.sin((2 * Math.PI * frequency * index) / rate));
}

function run(rate, signal, blockSize = 128) {
  const chunks = [];
  const chunker = new PcmChunker(rate, (pcm, rms) => chunks.push({ samples: new Int16Array(pcm), rms }));
  for (let offset = 0; offset < signal.length; offset += blockSize) chunker.process(signal.subarray(offset, offset + blockSize));
  return chunks;
}

test("resamples 48 kHz and 44.1 kHz to 24 kHz without drifting across blocks", () => {
  for (const rate of [48000, 44100]) {
    const chunks = run(rate, sine(rate, 440, 2));
    const samples = chunks.length * CHUNK_SAMPLES;
    assert.ok(Math.abs(samples - 48000) <= CHUNK_SAMPLES, `${rate} Hz → ${samples} samples for 2 s`);
  }
});

test("speech band passes, content above the new Nyquist is filtered out", () => {
  const speech = run(48000, sine(48000, 1000, 1)).slice(2);
  const ultrasonic = run(48000, sine(48000, 18000, 1)).slice(2);
  const average = (chunks) => chunks.reduce((sum, chunk) => sum + chunk.rms, 0) / chunks.length;
  assert.ok(average(speech) > 0.3, "1 kHz keeps its level");
  assert.ok(average(ultrasonic) < 0.03, "18 kHz would alias to 6 kHz without the low-pass");
});

test("24 kHz input is passed through unchanged", () => {
  const signal = sine(24000, 440, 0.1);
  const [first] = run(24000, signal);
  assert.equal(first.samples[10], Math.round(signal[10] * 0x7fff) || Math.trunc(signal[10] * 0x7fff));
});

test("VAD detects a speech turn and its end after the hangover", () => {
  const vad = new VoiceActivityDetector();
  const events = [];
  let now = 0;
  const feed = (rms, count) => {
    for (let index = 0; index < count; index += 1) {
      now += 50;
      const event = vad.update(rms, now, 50);
      if (event) events.push({ ...event, now });
    }
  };
  feed(0.001, 40);
  feed(0.1, 40);
  feed(0.001, 30);
  assert.deepEqual(events.map((event) => event.type), ["speech-start", "speech-end"]);
  assert.ok(Math.abs(events[0].atMs - (2000 - 250)) <= 100, "start includes pre-roll");
  assert.ok(Math.abs(events[1].atMs - 4000) <= 60, "end is when the silence began");
});

test("VAD adapts to steady background noise", () => {
  const vad = new VoiceActivityDetector();
  let now = 0;
  let starts = 0;
  for (let index = 0; index < 400; index += 1) {
    now += 50;
    if (vad.update(0.012 + (index % 3) * 0.001, now, 50)?.type === "speech-start") starts += 1;
  }
  assert.ok(starts <= 1, "constant room noise isn't treated as continuous speech starts");
});
