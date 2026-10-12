// Energy-based voice activity detector used to decide when a speech turn ends.
// gpt-live-transcribe has no server VAD, so the client commits the audio buffer at the end of each turn.

export class VoiceActivityDetector {
  constructor({ startMs = 120, hangoverMs = 650, prerollMs = 250, minThreshold = 0.006, ratio = 3.2 } = {}) {
    this.startMs = startMs;
    this.hangoverMs = hangoverMs;
    this.prerollMs = prerollMs;
    this.minThreshold = minThreshold;
    this.ratio = ratio;
    this.reset();
  }

  reset() {
    this.noiseFloor = 0.002;
    this.speaking = false;
    this.aboveSince = null;
    this.belowSince = null;
    this.lastVoiceAt = null;
  }

  get threshold() {
    return Math.max(this.minThreshold, this.noiseFloor * this.ratio);
  }

  // rms: level of a chunk that ends at nowMs and lasts chunkMs. Returns an event or null.
  update(rms, nowMs, chunkMs) {
    const chunkStart = nowMs - chunkMs;
    const threshold = this.threshold;
    if (!this.speaking) {
      // Track the background level slowly so the threshold adapts to room noise.
      this.noiseFloor = rms < threshold ? this.noiseFloor * 0.97 + rms * 0.03 : this.noiseFloor * 0.999 + rms * 0.001;
      if (rms >= threshold) {
        this.aboveSince ??= chunkStart;
        if (nowMs - this.aboveSince >= this.startMs) {
          this.speaking = true;
          this.belowSince = null;
          this.lastVoiceAt = nowMs;
          return { type: "speech-start", atMs: Math.max(0, this.aboveSince - this.prerollMs) };
        }
      } else {
        this.aboveSince = null;
      }
      return null;
    }

    if (rms >= threshold * 0.75) {
      this.belowSince = null;
      this.lastVoiceAt = nowMs;
      return null;
    }
    this.belowSince ??= chunkStart;
    if (nowMs - this.belowSince >= this.hangoverMs) {
      this.speaking = false;
      this.aboveSince = null;
      const endMs = this.belowSince;
      this.belowSince = null;
      return { type: "speech-end", atMs: endMs };
    }
    return null;
  }

  // Milliseconds of silence so far in the current turn (0 while voice is present).
  silenceMs(nowMs) {
    return this.speaking && this.belowSince !== null ? nowMs - this.belowSince : 0;
  }
}
