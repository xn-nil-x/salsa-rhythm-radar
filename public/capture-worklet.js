/**
 * Capture worklet: downmixes the input to mono and ships blocks of samples,
 * stamped with their absolute frame index, to the analysis worker through a
 * MessagePort. No analysis happens on the audio thread.
 */
const BLOCK = 1024;

class SrrCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.out = null;
    this.buf = new Float32Array(BLOCK);
    this.n = 0;
    this.start = 0;
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'port') this.out = e.data.port;
    };
  }

  process(inputs) {
    const input = inputs[0];
    const len = input && input.length ? input[0].length : 128;
    if (this.n === 0) this.start = currentFrame;
    const ch = input ? input.length : 0;
    for (let i = 0; i < len; i++) {
      let s = 0;
      for (let c = 0; c < ch; c++) s += input[c][i];
      this.buf[this.n++] = ch ? s / ch : 0;
      if (this.n === BLOCK) {
        if (this.out) this.out.postMessage({ frame: this.start, samples: this.buf }, [this.buf.buffer]);
        this.buf = new Float32Array(BLOCK);
        this.n = 0;
        this.start = currentFrame + i + 1;
      }
    }
    return true;
  }
}

registerProcessor('srr-capture', SrrCapture);
