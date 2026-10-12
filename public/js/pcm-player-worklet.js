// Plays PCM chunks pushed from the main thread (system audio captured natively) into the audio graph,
// so they can feed a MediaStreamAudioDestinationNode → WebRTC track for the translation session.
// Keeps a small jitter buffer, caps latency, and resamples when the context isn't 24 kHz.

class PcmPlayerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.inputRate = options.processorOptions?.inputRate ?? 24000;
    this.step = this.inputRate / sampleRate;
    this.chunks = [];
    this.head = 0;
    this.available = 0;
    this.fraction = 0;
    this.playing = false;
    this.port.onmessage = ({ data }) => {
      this.chunks.push(data);
      this.available += data.length;
      // Never fall more than half a second behind: drop the oldest audio instead.
      const limit = this.inputRate / 2;
      if (this.available > limit) this.drop(this.available - this.inputRate / 5);
    };
  }

  sample(offset) {
    let index = this.head + offset;
    for (const chunk of this.chunks) {
      if (index < chunk.length) return chunk[index];
      index -= chunk.length;
    }
    return 0;
  }

  drop(count) {
    this.available -= count;
    this.head += count;
    while (this.chunks.length && this.head >= this.chunks[0].length) {
      this.head -= this.chunks[0].length;
      this.chunks.shift();
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0][0];
    // Start (and restart after an underrun) only once 100 ms are buffered.
    if (!this.playing && this.available >= this.inputRate / 10) this.playing = true;
    for (let index = 0; index < output.length; index += 1) {
      if (!this.playing || this.available < 2) {
        output[index] = 0;
        this.playing = false;
        continue;
      }
      const a = this.sample(0);
      const b = this.sample(1);
      output[index] = a + (b - a) * this.fraction;
      this.fraction += this.step;
      const whole = Math.floor(this.fraction);
      if (whole > 0) {
        this.drop(Math.min(whole, this.available));
        this.fraction -= whole;
      }
    }
    return true;
  }
}

registerProcessor("pcm-player", PcmPlayerProcessor);
