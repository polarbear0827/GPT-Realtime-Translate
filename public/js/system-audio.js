// Audio source for "電腦播放的聲音": the macOS app captures system audio natively and pushes 24 kHz
// PCM16 chunks into the page (window.__kltSystemAudio). Same interface as AudioInput (audio.js):
// chunks go to transcription / VAD / level meter, and a generated MediaStreamTrack feeds WebRTC.

import { platform } from "./platform.js";

export class SystemAudioInput {
  constructor({ onChunk, onEnded } = {}) {
    this.onChunk = onChunk;
    this.onEnded = onEnded;
    this.closed = false;
    this.started = false;
  }

  static get supported() {
    return Boolean(platform?.startSystemAudio);
  }

  async open({ muteSource = false } = {}) {
    if (!SystemAudioInput.supported) {
      const error = new Error("擷取電腦播放的聲音只能在 macOS App（macOS 14.2 以上）使用。");
      error.name = "NotSupportedError";
      throw error;
    }
    await this.createTrack();
    if (this.closed) throw new DOMException("Cancelled", "AbortError");
    window.__kltSystemAudio = (base64, rms, peak) => this.receive(base64, rms, peak);
    window.__kltSystemAudioEnded = (message) => {
      if (!this.closed) this.onEnded?.(message || "電腦聲音擷取中斷。");
    };
    await platform.startSystemAudio({ muteSource });
    this.started = true;
    if (this.closed) {
      this.close();
      throw new DOMException("Cancelled", "AbortError");
    }
  }

  async createTrack() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    try {
      this.context = new AudioContextClass({ sampleRate: 24000, latencyHint: "interactive" });
    } catch {
      this.context = new AudioContextClass({ latencyHint: "interactive" });
    }
    await this.context.audioWorklet.addModule(new URL("./pcm-player-worklet.js", import.meta.url));
    this.player = new AudioWorkletNode(this.context, "pcm-player", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { inputRate: 24000 },
    });
    this.destination = this.context.createMediaStreamDestination();
    this.player.connect(this.destination);
    if (this.context.state === "suspended") await this.context.resume().catch(() => {});
  }

  receive(base64, rms, peak) {
    if (this.closed) return;
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const samples = new Int16Array(bytes.buffer);
    const floats = new Float32Array(samples.length);
    for (let index = 0; index < samples.length; index += 1) floats[index] = samples[index] / 32768;
    this.player?.port.postMessage(floats, [floats.buffer]);
    this.onChunk?.(bytes.buffer, Number(rms) || 0, Number(peak) || 0, performance.now());
  }

  get track() {
    return this.destination?.stream.getAudioTracks()[0] ?? null;
  }

  close() {
    if (this.closed && !this.started) return;
    this.closed = true;
    if (this.started) {
      this.started = false;
      platform.stopSystemAudio();
    }
    if (window.__kltSystemAudio) window.__kltSystemAudio = null;
    this.player?.disconnect();
    this.context?.close().catch(() => {});
    this.player = this.context = this.destination = null;
  }
}
