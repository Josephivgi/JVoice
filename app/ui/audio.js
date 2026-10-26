'use strict';
// Audio helpers shared by the dictation recorder (overlay) and the speed test (main window).
// Loaded as a plain script in the pages, and with require() in the unit tests.
(function (root) {
  const TARGET_RATE = 16000;

  // Copies microphone samples off the audio thread in blocks of 1024.
  const WORKLET = `
class Tap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(1024); this.n = 0; this.alive = true;
    this.port.onmessage = (e) => {
      // flush: send the partial buffer so the last words are not cut off. dispose: stop for good.
      if (e.data === 'flush') { this.port.postMessage({ flushed: this.buf.slice(0, this.n) }); this.n = 0; }
      else if (e.data === 'dispose') { this.alive = false; this.port.close(); }
    };
  }
  process(inputs) {
    if (!this.alive) return false;
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) { this.port.postMessage(this.buf, [this.buf.buffer]); this.buf = new Float32Array(1024); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('tap', Tap);`;

  // Averages input samples into 16 kHz output, chunk by chunk. The position carries over between
  // chunks, so no samples are dropped at chunk edges (only used when the device will not run at 16 kHz).
  function makeResampler(from, to) {
    if (from === to) return (data) => data;
    const ratio = from / to;
    let pending = new Float32Array(0), pos = 0; // pos: where the next output sample starts in pending
    return (data) => {
      const all = new Float32Array(pending.length + data.length);
      all.set(pending); all.set(data, pending.length);
      const out = [];
      while (pos + ratio <= all.length) {
        const start = Math.floor(pos), end = Math.floor(pos + ratio);
        let s = 0; for (let j = start; j < end; j++) s += all[j];
        out.push(s / Math.max(1, end - start));
        pos += ratio;
      }
      const keep = Math.floor(pos);
      pending = all.slice(keep); pos -= keep;
      return Float32Array.from(out);
    };
  }

  function toInt16(samples) {
    const out = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  // Writes the WAV straight from the chunk list, so the recording is never held twice.
  function encodeWav(chunks, rate) {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const buf = new ArrayBuffer(44 + total * 2), v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + total * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, total * 2, true);
    const pcm = new Int16Array(buf, 44); // little-endian on every Windows machine
    let o = 0; for (const c of chunks) { pcm.set(c, o); o += c.length; }
    return { wav: new Uint8Array(buf), samples: total };
  }

  // Splits a long recording into pieces of about 8 to 20 seconds for the speed test, so each piece
  // can be transcribed while the user keeps talking. A piece ends in a pause where possible, so words
  // are not cut in half. push() returns a finished piece ({ chunks, samples, peak }) or null.
  function makeSegmenter({ rate = TARGET_RATE, minSec = 8, maxSec = 20, pauseMs = 250 } = {}) {
    const min = minSec * rate, max = maxSec * rate, pause = (pauseMs / 1000) * rate;
    let chunks = [], samples = 0, peak = 0, quiet = 0, speech = 0;
    const take = () => {
      const piece = { chunks, samples, peak };
      chunks = []; samples = 0; peak = 0; quiet = 0;
      return piece;
    };
    return {
      // chunk: Int16Array at `rate`. level: RMS of the chunk (0 to 1). chunkPeak: loudest sample (0 to 1).
      push(chunk, level, chunkPeak) {
        if (!chunk.length) return null;
        chunks.push(chunk); samples += chunk.length;
        if (chunkPeak > peak) peak = chunkPeak;
        // The speaking level is learned as the test runs; a pause is well below it.
        if (level > 0.01) speech = speech ? speech * 0.95 + level * 0.05 : level;
        const quietBelow = Math.max(0.004, speech * 0.12);
        quiet = level < quietBelow ? quiet + chunk.length : 0;
        if (samples >= max || (samples >= min && quiet >= pause)) return take();
        return null;
      },
      flush() { return samples ? take() : null; },
      get samples() { return samples; },
    };
  }

  const api = { TARGET_RATE, WORKLET, makeResampler, toInt16, encodeWav, makeSegmenter };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.JVoiceAudio = api;
})(typeof self !== 'undefined' ? self : this);
