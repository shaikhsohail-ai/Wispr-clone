/* AudioWorklet that forwards raw microphone samples to the page in ~4096-sample batches. */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(4096);
    this.offset = 0;
    this.port.onmessage = (event) => {
      if (event.data === 'flush') {
        this.flush();
        this.port.postMessage('flushed');
      }
    };
  }

  flush() {
    if (this.offset === 0) return;
    const out = this.buffer.slice(0, this.offset);
    this.offset = 0;
    this.port.postMessage(out, [out.buffer]);
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    let i = 0;
    while (i < channel.length) {
      const n = Math.min(channel.length - i, this.buffer.length - this.offset);
      this.buffer.set(channel.subarray(i, i + n), this.offset);
      this.offset += n;
      i += n;
      if (this.offset === this.buffer.length) this.flush();
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
