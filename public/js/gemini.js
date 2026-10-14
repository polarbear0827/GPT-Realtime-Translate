// Connections to the Gemini Live API (Google), each opened with a single-use ephemeral token that the
// backend locked to one session setup:
//   kind "translate"  – gemini-3.5-live-translate-preview: translated speech plus transcripts of what
//                       was said (input-delta) and of the translation (output-delta)
//   kind "transcribe" – gemini-3.5-transcribe-live: interim and final transcripts of each utterance
// Same interface as the OpenAI clients in realtime.js (connect / append / commit / setAudioEnabled /
// close), so the session controller treats both providers alike. Audio comes in as the app's 24 kHz
// PCM16 chunks and goes out as 16 kHz, 100 ms per message.

import { Biquad } from "./pcm-processor.js";
import { delay, toBase64 } from "./realtime.js";

export const GEMINI_LIVE_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";
const CONNECT_TIMEOUT_MS = 15_000;
const DRAIN_TIMEOUT_MS = 4_000;
// A graceful close waits until the service has been quiet this long (or DRAIN_TIMEOUT_MS).
const DRAIN_QUIET_MS = 1_200;
const SEND_SAMPLES = 1600;
const INPUT_MIME = "audio/pcm;rate=16000";

// 24 kHz → 16 kHz: low-pass below the new Nyquist frequency, then keep 2 samples out of every 3
// (interpolating the one that falls between two input samples). State carries across chunks.
export class Downsampler {
  constructor() {
    this.filters = [new Biquad(7200, 24000), new Biquad(7200, 24000)];
    this.position = 0;
    this.last = 0;
  }

  process(int16) {
    const count = int16.length;
    const input = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
      let value = int16[index] / 32768;
      for (const filter of this.filters) value = filter.process(value);
      input[index] = value;
    }
    const output = [];
    let position = this.position;
    while (position < count) {
      const index = Math.floor(position);
      const fraction = position - index;
      if (fraction > 0 && index + 1 >= count) break;
      const a = index < 0 ? this.last : input[index];
      const value = fraction > 0 ? a + (input[index + 1] - a) * fraction : a;
      output.push(Math.max(-32768, Math.min(32767, Math.round(value * 32768))));
      position += 1.5;
    }
    this.position = position - count;
    if (count > 0) this.last = input[count - 1];
    return Int16Array.from(output);
  }
}

// Transcript messages become appended text whether the service sends each new piece (incremental)
// or everything so far in the turn (cumulative).
export class Increments {
  constructor() {
    this.text = "";
  }

  next(chunk) {
    if (this.text.length >= 4 && chunk.startsWith(this.text)) {
      const delta = chunk.slice(this.text.length);
      this.text = chunk;
      return delta;
    }
    this.text = (this.text + chunk).slice(-4000);
    return chunk;
  }

  reset() {
    this.text = "";
  }
}

export class GeminiLiveClient {
  constructor({ kind, playAudio = false, onEvent, onState }, deps = {}) {
    this.kind = kind;
    this.playAudio = playAudio;
    this.onEvent = onEvent;
    this.onState = onState;
    this.WebSocket = deps.WebSocket ?? globalThis.WebSocket;
    this.createPlayer = deps.createPlayer ?? (() => new SpeechPlayer());
    this.closing = false;
    this.audioEnabled = true;
    this.downsampler = new Downsampler();
    this.outgoing = [];
    this.outgoingLength = 0;
    this.input = new Increments();
    this.output = new Increments();
    this.item = 0;
    this.itemText = "";
    this.finalized = "";
    this.lastMessageAt = 0;
  }

  get isOpen() {
    return this.ws?.readyState === 1;
  }

  // `secret` is what the backend returned: { token, setup }.
  async connect({ token, setup }, { audioEnabled = true } = {}) {
    this.audioEnabled = audioEnabled;
    const ws = new this.WebSocket(`${GEMINI_LIVE_URL}?access_token=${token}`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Gemini 連線逾時。")), CONNECT_TIMEOUT_MS);
      ws.onopen = () => ws.send(JSON.stringify({ setup }));
      ws.onmessage = ({ data }) => {
        const message = parseMessage(data);
        if (!message?.setupComplete) return;
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {};
      ws.onclose = (event) => {
        clearTimeout(timer);
        reject(new Error(closeMessage(event, "無法建立 Gemini 連線。")));
      };
    });
    ws.onmessage = ({ data }) => this.handleMessage(parseMessage(data));
    ws.onclose = (event) => {
      this.resolveDrained?.();
      if (!this.closing) this.onState?.("failed", closeMessage(event, "Gemini 連線中斷。"));
    };
    this.connected = true;
    this.connectedAt = performance.now();
    this.onState?.("live");
  }

  // A 24 kHz PCM16 chunk from the microphone or system audio.
  append(pcm) {
    if (!this.isOpen || !this.audioEnabled) return false;
    const samples = this.downsampler.process(new Int16Array(pcm));
    this.outgoing.push(samples);
    this.outgoingLength += samples.length;
    if (this.outgoingLength >= SEND_SAMPLES) this.flushAudio();
    return true;
  }

  flushAudio() {
    if (!this.outgoingLength) return;
    const joined = new Int16Array(this.outgoingLength);
    let offset = 0;
    for (const samples of this.outgoing) {
      joined.set(samples, offset);
      offset += samples.length;
    }
    this.outgoing = [];
    this.outgoingLength = 0;
    if (this.isOpen) this.send({ realtimeInput: { audio: { data: toBase64(joined.buffer), mimeType: INPUT_MIME } } });
  }

  // The client-side VAD heard the speaker stop ("hybrid" VAD): the service finalizes the utterance now
  // instead of waiting for its own silence detection. Sending audio again reopens the stream.
  commit(turn) {
    if (!this.isOpen) return false;
    this.flushAudio();
    this.send({ realtimeInput: { audioStreamEnd: true } });
    if (this.kind === "transcribe" && this.itemText) this.onEvent?.({ type: "committed", itemId: this.itemId, turn });
    return true;
  }

  get itemId() {
    return `gemini-${this.item}`;
  }

  send(message) {
    try {
      this.ws.send(JSON.stringify(message));
    } catch {
      // Closed meanwhile; onclose reports it.
    }
  }

  handleMessage(message) {
    if (!message) return;
    this.lastMessageAt = performance.now();
    if (message.goAway) {
      this.onState?.("expiring");
      return;
    }
    const content = message.serverContent;
    if (!content) return;
    if (this.kind === "translate") {
      const said = content.inputTranscription?.text;
      if (typeof said === "string" && said) this.emitDelta("input-delta", this.input.next(said));
      const translated = content.outputTranscription?.text;
      if (typeof translated === "string" && translated) this.emitDelta("output-delta", this.output.next(translated));
      if (this.playAudio) {
        for (const part of content.modelTurn?.parts ?? []) {
          if (typeof part?.inlineData?.data === "string") this.play(part.inlineData.data);
        }
      }
      if (content.turnComplete || content.generationComplete || content.interrupted) {
        this.input.reset();
        this.output.reset();
      }
      return;
    }
    const interim = content.interimInputTranscription?.text;
    if (typeof interim === "string") this.partial(interim);
    const final = content.inputTranscription?.text;
    if (typeof final === "string") this.complete(final);
  }

  emitDelta(type, delta) {
    if (delta) this.onEvent?.({ type, delta });
  }

  // Interim text is the current hypothesis for the utterance, so it replaces what was shown.
  partial(text) {
    let hypothesis = text;
    if (this.finalized && hypothesis.startsWith(this.finalized)) hypothesis = hypothesis.slice(this.finalized.length).trimStart();
    else this.finalized = "";
    if (!hypothesis.trim() || hypothesis === this.itemText) return;
    this.itemText = hypothesis;
    this.onEvent?.({ type: "partial", itemId: this.itemId, text: hypothesis });
  }

  complete(text) {
    if (!text.trim() && !this.itemText) return;
    this.onEvent?.({ type: "completed", itemId: this.itemId, transcript: text });
    this.finalized = text;
    this.itemText = "";
    this.item += 1;
    this.resolveDrained?.();
  }

  play(base64) {
    if (!this.player) {
      this.player = this.createPlayer();
      this.player.start().catch(() => {});
    }
    this.player.push(base64);
  }

  setAudioEnabled(enabled) {
    this.audioEnabled = enabled;
    if (!enabled) {
      this.outgoing = [];
      this.outgoingLength = 0;
    }
  }

  setPlayAudio(play) {
    this.playAudio = play;
    if (!play) {
      this.player?.close();
      this.player = null;
    }
  }

  // Graceful close tells the service the audio has ended, then waits for the last words
  // (a final transcript, or until it has been quiet for a moment).
  async close({ graceful = true } = {}) {
    if (this.closing) return;
    this.closing = true;
    if (graceful && this.isOpen) {
      this.flushAudio();
      this.send({ realtimeInput: { audioStreamEnd: true } });
      const drained = new Promise((resolve) => {
        this.resolveDrained = resolve;
      });
      const quiet = (async () => {
        this.lastMessageAt = performance.now();
        while (performance.now() - this.lastMessageAt < DRAIN_QUIET_MS) await delay(200);
      })();
      const waitForFinal = this.kind === "transcribe" && this.itemText ? drained : quiet;
      await Promise.race([waitForFinal, delay(DRAIN_TIMEOUT_MS)]);
    }
    if (this.ws && this.ws.readyState <= 1) this.ws.close(1000);
    this.player?.close();
    this.player = null;
  }
}

function parseMessage(data) {
  try {
    return JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
  } catch {
    return null;
  }
}

function closeMessage(event, fallback) {
  const reason = String(event?.reason || "").trim();
  return reason ? `${fallback}（${reason.slice(0, 160)}）` : fallback;
}

// Translated speech (24 kHz PCM16, base64) played through the speakers, queued so a translation that
// arrives faster than real time isn't cut.
class SpeechPlayer {
  async start() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.context = new AudioContextClass({ latencyHint: "interactive" });
    await this.context.audioWorklet.addModule(new URL("./pcm-player-worklet.js", import.meta.url));
    if (!this.context) return;
    this.node = new AudioWorkletNode(this.context, "pcm-player", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { inputRate: 24000, maxBufferSeconds: 60 },
    });
    this.node.connect(this.context.destination);
    for (const chunk of this.pending ?? []) this.node.port.postMessage(chunk, [chunk.buffer]);
    this.pending = null;
    if (this.context.state === "suspended") await this.context.resume().catch(() => {});
  }

  push(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const samples = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
    const floats = new Float32Array(samples.length);
    for (let index = 0; index < samples.length; index += 1) floats[index] = samples[index] / 32768;
    if (this.node) this.node.port.postMessage(floats, [floats.buffer]);
    else (this.pending ??= []).push(floats);
  }

  close() {
    this.node?.disconnect();
    this.context?.close().catch(() => {});
    this.node = this.context = null;
    this.pending = null;
  }
}
