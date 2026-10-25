// BoxComms radio audio, run on the audio thread (core/comms.js loads it into a 16 kHz AudioContext).
// comms-mic cuts the microphone into 20 ms frames of 16-bit PCM; comms-player keeps a small buffer per person
// talking (so the network's unevenness doesn't stutter) and mixes them.

const FRAME = 320; // 20 ms at 16 kHz

class Mic extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(FRAME);
    this.n = 0;
    this.peak = 0;
  }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const v = Math.max(-1, Math.min(1, ch[i]));
      this.peak = Math.max(this.peak, Math.abs(v));
      this.buf[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      if (this.n === FRAME) {
        this.port.postMessage({ pcm: this.buf.buffer, level: this.peak }, [this.buf.buffer]);
        this.buf = new Int16Array(FRAME);
        this.n = 0;
        this.peak = 0;
      }
    }
    return true;
  }
}

class Player extends AudioWorkletProcessor {
  constructor() {
    super();
    this.voices = new Map(); // id → { q: [Float32Array], pos, started, idle }
    this.port.onmessage = ({ data }) => {
      if (data.clear) { this.voices.clear(); return; }
      let v = this.voices.get(data.id);
      if (!v) this.voices.set(data.id, (v = { q: [], pos: 0, started: false, idle: 0 }));
      if (data.end) { v.ending = true; return; }
      const s = new Int16Array(data.pcm), f = new Float32Array(s.length);
      for (let i = 0; i < s.length; i++) f[i] = s[i] / 0x8000;
      v.q.push(f);
      v.ending = false;
      if (v.q.length > 25) v.q.splice(0, v.q.length - 4); // fell far behind: catch up
    };
  }
  process(inputs, outputs) {
    const out = outputs[0][0];
    out.fill(0);
    for (const [id, v] of this.voices) {
      // wait for three frames (60 ms) before starting, or for the end of a short transmission
      if (!v.started && (v.q.length >= 3 || (v.ending && v.q.length))) v.started = true;
      if (!v.started) continue;
      let i = 0;
      while (i < out.length && v.q.length) {
        const f = v.q[0];
        const take = Math.min(out.length - i, f.length - v.pos);
        for (let k = 0; k < take; k++) out[i + k] += f[v.pos + k];
        i += take; v.pos += take;
        if (v.pos >= f.length) { v.q.shift(); v.pos = 0; }
      }
      if (!v.q.length) {
        v.started = false; // ran dry: build the buffer up again
        if (v.ending || ++v.idle > 400) this.voices.delete(id);
      } else v.idle = 0;
    }
    for (let i = 0; i < out.length; i++) out[i] = Math.max(-1, Math.min(1, out[i]));
    return true;
  }
}

registerProcessor('comms-mic', Mic);
registerProcessor('comms-player', Player);
