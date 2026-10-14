// Converts microphone samples to 24 kHz mono PCM16 in 50 ms chunks and reports each chunk's RMS/peak.
// Used inside the AudioWorklet (audio thread) and by the ScriptProcessor fallback. When the input
// isn't 24 kHz, it low-pass filters (two cascaded biquads) before resampling to avoid aliasing and
// keeps its state across blocks so chunk boundaries stay continuous.

export const TARGET_RATE = 24000;
export const CHUNK_SAMPLES = 1200;

export class Biquad {
  constructor(cutoff, rate) {
    const w0 = (2 * Math.PI * cutoff) / rate;
    const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
    const cos = Math.cos(w0);
    const a0 = 1 + alpha;
    this.b0 = (1 - cos) / 2 / a0;
    this.b1 = (1 - cos) / a0;
    this.b2 = (1 - cos) / 2 / a0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }

  process(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

export class PcmChunker {
  constructor(inputRate, onChunk) {
    this.ratio = inputRate / TARGET_RATE;
    this.onChunk = onChunk;
    this.filters = this.ratio > 1 ? [new Biquad(TARGET_RATE * 0.45, inputRate), new Biquad(TARGET_RATE * 0.45, inputRate)] : [];
    this.position = 0;
    this.previous = 0;
    this.scratch = new Float32Array(128);
    this.chunk = new Int16Array(CHUNK_SAMPLES);
    this.chunkIndex = 0;
    this.sumSquares = 0;
    this.peak = 0;
  }

  process(channel) {
    const length = channel.length;
    if (length === 0) return;
    if (this.ratio === 1) {
      for (let index = 0; index < length; index += 1) this.push(channel[index]);
      return;
    }
    if (this.scratch.length < length) this.scratch = new Float32Array(length);
    const samples = this.scratch;
    for (let index = 0; index < length; index += 1) {
      let value = channel[index];
      for (const filter of this.filters) value = filter.process(value);
      samples[index] = value;
    }
    // Linear interpolation over a virtual buffer where index -1 is the last sample of the previous block.
    while (this.position < length - 1) {
      const left = Math.floor(this.position);
      const fraction = this.position - left;
      const a = left < 0 ? this.previous : samples[left];
      const b = samples[left + 1];
      this.push(a + (b - a) * fraction);
      this.position += this.ratio;
    }
    this.position -= length;
    this.previous = samples[length - 1];
  }

  push(sample) {
    const clamped = Math.max(-1, Math.min(1, sample));
    this.chunk[this.chunkIndex] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    this.sumSquares += clamped * clamped;
    const magnitude = Math.abs(clamped);
    if (magnitude > this.peak) this.peak = magnitude;
    this.chunkIndex += 1;
    if (this.chunkIndex === CHUNK_SAMPLES) {
      const pcm = this.chunk.buffer;
      this.onChunk(pcm, Math.sqrt(this.sumSquares / CHUNK_SAMPLES), this.peak);
      this.chunk = new Int16Array(CHUNK_SAMPLES);
      this.chunkIndex = 0;
      this.sumSquares = 0;
      this.peak = 0;
    }
  }
}
