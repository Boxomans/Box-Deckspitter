// BoxTunnel's noise gate (an AudioWorklet, runs on the audio thread). Below the threshold the sound fades out;
// a short hold keeps it open between words so speech doesn't chop. threshold -100 dB = always open.

class BdsGate extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'threshold', defaultValue: -100, minValue: -100, maxValue: 0, automationRate: 'k-rate' }];
  }

  constructor() {
    super();
    this.env = 0; // follows the input's peak level
    this.g = 1; // the gate's own volume, 0..1
    this.hold = 0; // samples left before it may close
    const sr = sampleRate;
    this.atk = 1 - Math.exp(-1 / (0.002 * sr)); // opens in ~2 ms
    this.rel = 1 - Math.exp(-1 / (0.12 * sr)); // fades out over ~120 ms
    this.envRel = 1 - Math.exp(-1 / (0.05 * sr));
    this.holdN = Math.round(0.18 * sr);
  }

  process(inputs, outputs, params) {
    const inp = inputs[0];
    const out = outputs[0];
    if (!inp || !inp.length) return true; // nothing connected: silence
    const db = params.threshold[0];
    const thr = db <= -99 ? 0 : Math.pow(10, db / 20);
    const n = inp[0].length;
    for (let i = 0; i < n; i++) {
      let peak = 0;
      for (let c = 0; c < inp.length; c++) { const v = Math.abs(inp[c][i]); if (v > peak) peak = v; }
      this.env = peak > this.env ? peak : this.env + (peak - this.env) * this.envRel;
      const open = this.env >= thr;
      if (open) this.hold = this.holdN;
      else if (this.hold > 0) this.hold--;
      const target = open || this.hold > 0 ? 1 : 0;
      this.g += (target - this.g) * (target > this.g ? this.atk : this.rel);
      for (let c = 0; c < out.length; c++) out[c][i] = (inp[c] || inp[0])[i] * this.g;
    }
    return true;
  }
}

registerProcessor('bds-gate', BdsGate);
