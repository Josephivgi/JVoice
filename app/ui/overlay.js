'use strict';
// Floating status pill + microphone recorder. Audio is captured as 16 kHz mono PCM and sent to main as WAV.
const $ = (id) => document.getElementById(id);
const pill = $('pill'), label = $('label'), sub = $('sub'), time = $('time'), wave = $('wave'), live = $('live');
const BARS = 22;
for (let i = 0; i < BARS; i++) wave.appendChild(document.createElement('i'));
const bars = [...wave.children];

const TARGET_RATE = 16000;
const WORKLET = `
class Tap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(1024); this.n = 0;
    // A flush request sends the partial buffer so the last words are not cut off.
    this.port.onmessage = () => { this.port.postMessage({ flushed: this.buf.slice(0, this.n) }); this.n = 0; };
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('tap', Tap);`;

let rec = null; // { stream, ctx, node, chunks, startedAt, peak, timer, limitTimer, cancelled }
let sfx = null;
let levels = new Array(BARS).fill(0);

function beep(kind, on) {
  if (!on) return;
  try {
    sfx = sfx || new AudioContext();
    const t = sfx.currentTime;
    const o = sfx.createOscillator(), g = sfx.createGain();
    const [f1, f2] = kind === 'start' ? [660, 880] : kind === 'stop' ? [740, 520] : [300, 220];
    o.type = 'sine';
    o.frequency.setValueAtTime(f1, t);
    o.frequency.exponentialRampToValueAtTime(f2, t + 0.09);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.07, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    o.connect(g).connect(sfx.destination);
    o.start(t); o.stop(t + 0.13);
  } catch { /* sound is optional */ }
}

function fmt(ms) { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }

const SPOKEN = { recording: 'Recording', transcribing: 'Transcribing', improving: 'Improving text', cancelled: 'Cancelled' };
function render(state, data = {}) {
  pill.dataset.state = state;
  sub.textContent = '';
  switch (state) {
    case 'starting': label.textContent = 'Starting microphone'; break;
    case 'recording': break;
    case 'transcribing': label.textContent = 'Transcribing'; break;
    case 'improving': label.textContent = 'Improving'; sub.textContent = 'AI cleanup'; break;
    case 'done':
      label.textContent = data.pasted ? `Pasted ${data.words} ${data.words === 1 ? 'word' : 'words'}` : `Copied ${data.words} ${data.words === 1 ? 'word' : 'words'}`;
      sub.textContent = data.note || (data.pasted ? '' : 'Press Ctrl+V to paste');
      break;
    case 'error': label.textContent = data.message || 'Something went wrong.'; break;
    case 'cancelled': label.textContent = 'Cancelled'; break;
    default: break;
  }
  // One short announcement per state change for screen readers; the timer and waveform stay silent.
  const said = state === 'done' || state === 'error' ? [label.textContent, sub.textContent].filter(Boolean).join('. ') : SPOKEN[state] || '';
  if (said && live.textContent !== said) live.textContent = said;
  if (state === 'hidden') live.textContent = '';
}

function drawLevels() {
  if (!rec) return;
  for (let i = 0; i < BARS; i++) bars[i].style.transform = `scaleY(${Math.max(0.12, Math.min(1, levels[i]))})`;
  time.textContent = fmt(Date.now() - rec.startedAt);
  rec.raf = requestAnimationFrame(drawLevels);
}

async function start({ id, deviceId, sounds, maxSeconds }) {
  if (rec) teardown();
  const me = rec = { id, chunks: [], peak: 0, startedAt: Date.now(), sounds };
  const fail = (message) => window.jvoice.send('rec:error', { id, message });
  levels.fill(0);
  render('starting');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: deviceId ? { exact: deviceId } : undefined, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (rec !== me) { stream.getTracks().forEach((t) => t.stop()); return; }
    me.stream = stream;
    let ctx;
    try { ctx = new AudioContext({ sampleRate: TARGET_RATE }); } catch { ctx = new AudioContext(); }
    me.ctx = ctx;
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    if (rec !== me) return;
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'tap');
    node.port.onmessage = (e) => {
      if (e.data.flushed) { if (e.data.flushed.length) me.chunks.push(e.data.flushed); me.flushed?.(); return; }
      const buf = e.data;
      me.chunks.push(buf);
      let sum = 0, pk = 0;
      for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); sum += v * v; if (v > pk) pk = v; }
      if (pk > me.peak) me.peak = pk;
      const rms = Math.sqrt(sum / buf.length);
      levels.shift(); levels.push(Math.min(1, rms * 9));
    };
    src.connect(node);
    me.node = node; me.src = src;
    me.startedAt = Date.now();
    render('recording');
    beep('start', me.sounds);
    me.raf = requestAnimationFrame(drawLevels);
    me.limitTimer = setTimeout(() => window.jvoice.send('rec:limit', id), (maxSeconds || 600) * 1000);
    stream.getAudioTracks()[0].addEventListener('ended', () => {
      if (rec === me) { teardown(); fail('The microphone was disconnected.'); }
    });
  } catch (err) {
    if (rec !== me) return;
    teardown();
    const name = err && err.name;
    const msg = name === 'NotAllowedError' ? 'Microphone access is blocked. Allow it in Windows privacy settings.'
      : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'No microphone found. Pick one in JVoice settings.'
      : name === 'NotReadableError' ? 'The microphone is busy in another app.'
      : `Could not start the microphone: ${err.message || err}`;
    fail(msg);
  }
}

function teardown() {
  if (!rec) return;
  const r = rec; rec = null;
  cancelAnimationFrame(r.raf);
  clearTimeout(r.limitTimer);
  try { r.src && r.src.disconnect(); r.node && r.node.disconnect(); } catch { /* already gone */ }
  if (r.stream) r.stream.getTracks().forEach((t) => t.stop());
  if (r.ctx) r.ctx.close().catch(() => {});
  return r;
}

function resample(data, from, to) {
  if (from === to) return data;
  const ratio = from / to, len = Math.floor(data.length / ratio), out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const start = Math.floor(i * ratio), end = Math.min(data.length, Math.floor((i + 1) * ratio));
    let s = 0; for (let j = start; j < end; j++) s += data[j];
    out[i] = s / Math.max(1, end - start);
  }
  return out;
}

function encodeWav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

async function stop({ id }) {
  const r = rec;
  if (!r || r.id !== id) { window.jvoice.send('rec:done', { id, error: 'The microphone never started.' }); return; }
  if (!r.node) { teardown(); window.jvoice.send('rec:done', { id, error: 'The microphone was still starting. Hold the keys a little longer.' }); return; }
  const ms = Date.now() - r.startedAt;
  const rate = r.ctx.sampleRate;
  // Ask the worklet for its partial buffer and wait for it (or give up after 300 ms).
  await new Promise((res) => { r.flushed = res; r.node.port.postMessage('flush'); setTimeout(res, 300); });
  if (rec !== r) return; // cancelled or replaced while flushing; main ignores this session now
  teardown();
  beep('stop', r.sounds);
  const total = r.chunks.reduce((n, c) => n + c.length, 0);
  const all = new Float32Array(total);
  let o = 0; for (const c of r.chunks) { all.set(c, o); o += c.length; }
  const pcm = resample(all, rate, TARGET_RATE);
  window.jvoice.send('rec:done', { id, wav: encodeWav(pcm, TARGET_RATE), ms, peak: r.peak });
}

window.jvoice.on('rec:start', start);
window.jvoice.on('rec:stop', stop);
window.jvoice.on('rec:cancel', () => { teardown(); });
window.jvoice.on('overlay:state', ({ state, ...data }) => { if (state !== 'recording') render(state, data); });
render('hidden');
