// Microphone capture. The MediaStream track feeds WebRTC (translation) directly; an AudioWorklet
// produces 24 kHz PCM16 chunks for the transcription WebSocket, the level meter and the VAD.

import { PcmChunker } from "./pcm-processor.js";

export const CHUNK_MS = 50;

export class AudioInput {
  constructor({ onChunk, onEnded } = {}) {
    this.onChunk = onChunk;
    this.onEnded = onEnded;
    this.closed = false;
  }

  async open({ deviceId = "", processing = "standard" } = {}) {
    if (!navigator.mediaDevices?.getUserMedia) {
      const error = new Error("這個環境無法使用麥克風（需要安全連線）。");
      error.name = "NotSupportedError";
      throw error;
    }
    const standard = processing !== "raw";
    const audio = {
      channelCount: 1,
      echoCancellation: standard,
      noiseSuppression: standard,
      autoGainControl: standard,
    };
    if (deviceId) audio.deviceId = { exact: deviceId };
    const stream = await navigator.mediaDevices.getUserMedia({ audio });
    if (this.closed) {
      stream.getTracks().forEach((track) => track.stop());
      throw new DOMException("Cancelled", "AbortError");
    }
    this.stream = stream;
    this.track.addEventListener("ended", () => {
      if (!this.closed) this.onEnded?.();
    });
    try {
      await this.connectWorklet();
    } catch (error) {
      this.close();
      throw error;
    }
    return stream;
  }

  async connectWorklet() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    // Ask for a 24 kHz context so the browser resamples; fall back to the device rate when the
    // engine refuses mismatched rates (the worklet then resamples itself).
    let context = null;
    try {
      context = new AudioContextClass({ sampleRate: 24000, latencyHint: "interactive" });
      this.source = context.createMediaStreamSource(this.stream);
    } catch {
      await context?.close().catch(() => {});
      context = new AudioContextClass({ latencyHint: "interactive" });
      this.source = context.createMediaStreamSource(this.stream);
    }
    this.context = context;
    const emit = (pcm, rms, peak) => {
      if (!this.closed) this.onChunk?.(pcm, rms, peak, performance.now());
    };
    try {
      await context.audioWorklet.addModule(new URL("./pcm-worklet.js", import.meta.url));
      if (this.closed) throw new DOMException("Cancelled", "AbortError");
      this.node = new AudioWorkletNode(context, "pcm-capture", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      this.node.port.onmessage = ({ data }) => emit(data.pcm, data.rms, data.peak);
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      // Engines without AudioWorklet support: same processing on the main thread.
      const chunker = new PcmChunker(context.sampleRate, emit);
      this.node = context.createScriptProcessor(2048, 1, 1);
      this.node.onaudioprocess = (event) => chunker.process(event.inputBuffer.getChannelData(0));
    }
    // The worklet outputs silence; a muted gain keeps it in the rendered graph on every engine.
    this.sink = context.createGain();
    this.sink.gain.value = 0;
    this.source.connect(this.node);
    this.node.connect(this.sink);
    this.sink.connect(context.destination);
    if (context.state === "suspended") await context.resume().catch(() => {});
  }

  get track() {
    return this.stream?.getAudioTracks()[0] ?? null;
  }

  close() {
    this.closed = true;
    if (this.node?.port) this.node.port.onmessage = null;
    if (this.node) this.node.onaudioprocess = null;
    this.source?.disconnect();
    this.node?.disconnect();
    this.sink?.disconnect();
    this.context?.close().catch(() => {});
    this.stream?.getTracks().forEach((track) => track.stop());
    this.source = this.node = this.sink = this.context = this.stream = null;
  }
}

export async function listMicrophones() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === "audioinput" && device.deviceId && device.deviceId !== "default");
  } catch {
    return [];
  }
}

export async function microphonePermissionState() {
  try {
    const result = await navigator.permissions?.query({ name: "microphone" });
    return result?.state || "";
  } catch {
    return "";
  }
}

export function levelToDb(rms) {
  return rms > 0 ? Math.max(-60, 20 * Math.log10(rms)) : -60;
}
