// BoxTunnel's pitch shifter (an AudioWorklet, runs on the audio thread): two read heads slide through a short
// delay line faster or slower than it fills, each faded in and out so the jumps back don't click. Quick enough
// for a live mic, at the cost of a slight warble, which suits a voice changer.

class BdsPitch extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'semitones', defaultValue: 0, minValue: -24, maxValue: 24, automationRate: 'k-rate' }];
  }

  constructor() {
    super();
    this.size = Math.round(sampleRate * 0.06); // the window: longer is smoother, shorter is less echoey
    this.n = this.size * 2 + 4;
    this.buf = [new Float32Array(this.n), new Float32Array(this.n)];
    this.w = 0;
    this.phase = 0;
  }

  read(b, d) {
    let p = this.w - d;
    while (p < 0) p += this.n;
    const i = Math.floor(p), f = p - i;
    return b[i % this.n] * (1 - f) + b[(i + 1) % this.n] * f;
  }

  process(inputs, outputs, params) {
    const inp = inputs[0];
    const out = outputs[0];
    if (!inp || !inp.length) return true;
    const st = params.semitones[0];
    const len = inp[0].length;
    if (Math.abs(st) < 0.01) {
      for (let c = 0; c < out.length; c++) out[c].set(inp[c] || inp[0]);
      return true;
    }
    const step = (1 - Math.pow(2, st / 12)) / this.size;
    const chans = Math.min(out.length, 2);
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < chans; c++) this.buf[c][this.w] = (inp[c] || inp[0])[i];
      this.phase += step;
      this.phase -= Math.floor(this.phase);
      const p2 = (this.phase + 0.5) % 1;
      const g1 = Math.sin(Math.PI * this.phase), g2 = Math.sin(Math.PI * p2);
      for (let c = 0; c < chans; c++) {
        const b = this.buf[c];
        out[c][i] = this.read(b, this.phase * this.size + 1) * g1 + this.read(b, p2 * this.size + 1) * g2;
      }
      this.w = (this.w + 1) % this.n;
    }
    for (let c = chans; c < out.length; c++) out[c].set(out[0]);
    return true;
  }
}

registerProcessor('bds-pitch', BdsPitch);
