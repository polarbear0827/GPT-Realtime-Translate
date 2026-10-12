// AudioWorklet wrapper around PcmChunker: runs on the audio thread, so UI work on the main thread
// can't cause dropouts in the audio sent for transcription.

import { PcmChunker } from "./pcm-processor.js";

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunker = new PcmChunker(sampleRate, (pcm, rms, peak) => this.port.postMessage({ pcm, rms, peak }, [pcm]));
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) this.chunker.process(channel);
    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
