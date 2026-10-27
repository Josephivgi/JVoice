'use strict';
const $ = (id) => document.getElementById(id);
const api = window.jvoice;
let settings = null;
let models = [];

// ---------- helpers ----------
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) n.append(c);
  return n;
}
const svg = (d) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 20 20'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = d;
  return s;
};
const ICONS = {
  copy: '<rect x="7" y="7" width="9" height="9" rx="1.5"/><path d="M4 12.5V5.5A1.5 1.5 0 0 1 5.5 4h7"/>',
  trash: '<path d="M4.5 6h11M8 6V4.5h4V6M6 6l.7 9.5a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9L14 6"/>',
  retry: '<path d="M15.5 10a5.5 5.5 0 1 1-1.6-3.9M15.5 4v3.5H12"/>',
  edit: '<path d="M12.5 4.5l3 3L8 15H5v-3z"/>',
};

let toastTimer;
function toast(msg, err = false) {
  const t = $('toast');
  t.setAttribute('role', err ? 'alert' : 'status');
  t.textContent = msg;
  t.classList.toggle('err', err);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), err ? 4000 : 1800);
}

function keycaps(labels, big = false) {
  const wrap = el('span', { class: big ? 'keys big' : 'keys' });
  labels.forEach((k, i) => {
    if (i) wrap.append(el('span', { class: 'plus', 'aria-hidden': 'true' }, '+'));
    wrap.append(el('kbd', {}, k));
  });
  wrap.setAttribute('aria-label', labels.join(' plus '));
  return wrap;
}

function when(ts) {
  const d = new Date(ts), now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `Today ${time}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday ${time}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}
const secs = (ms) => (ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`);
const STYLE_NAMES = { clean: 'Light cleanup', rewrite: 'Rewrite', intent: 'Rewrite', custom: 'Rewrite', raw: 'No AI' };
// Older rows kept the style name even when the AI failed; no model means no AI ran.
const styleName = (row) => (row.style !== 'raw' && !row.ai_model ? 'No AI' : STYLE_NAMES[row.style] || row.style);
const shortModel = (id) => String(id || '').split('/').pop();

// Word level diff of what was heard (a) against what was pasted (b), for "Show changes".
function wordDiff(a, b) {
  const A = a.match(/\S+\s*/g) || [], B = b.match(/\S+\s*/g) || [];
  if (A.length * B.length > 4e5) return [b];
  // "to," and "To" count as the same word, and so do don't and don\u2019t.
  const t = (w) => w.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[^\p{L}\p{N}']/gu, '');
  const ta = A.map(t), tb = B.map(t); // normalized once; the table below compares every pair
  const L = Array.from({ length: A.length + 1 }, () => new Uint16Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) L[i][j] = ta[i] && ta[i] === tb[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && ta[i] && ta[i] === tb[j]) {
      // Same word, but punctuation or capitals may differ: that is a fix too.
      out.push(A[i].trim() === B[j].trim() ? B[j] : el('ins', { class: 'fix', title: `was "${A[i].trim()}"` }, B[j]));
      i++; j++;
    }
    else if (j < B.length && (i === A.length || L[i][j + 1] >= L[i + 1][j])) out.push(el('ins', {}, B[j++]));
    else out.push(el('del', {}, A[i++]));
  }
  return out;
}
const countChanges = (nodes) => nodes.filter((n) => typeof n !== 'string').length;

function confirmBox(title, text, yes) {
  return new Promise((resolve) => {
    const d = $('confirmDialog');
    $('confirmTitle').textContent = title;
    $('confirmText').textContent = text;
    $('confirmYes').textContent = yes;
    const done = (v) => { d.close(); resolve(v); };
    $('confirmYes').onclick = () => done(true);
    $('confirmNo').onclick = () => done(false);
    d.onclose = () => resolve(false);
    d.showModal();
    $('confirmNo').focus();
  });
}

// ---------- navigation ----------
function go(page) {
  for (const b of document.querySelectorAll('.nav')) { if (b.dataset.page === page) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); }
  for (const p of document.querySelectorAll('.page')) p.hidden = p.id !== `page-${page}`;
  $('main').scrollTop = 0;
  if (page === 'history') loadHistory();
  if (page === 'dictionary') loadDictionary();
  if (page === 'settings') { renderSettings(); loadKeyInfo(); loadMics(); loadModels(); }
  if (page === 'home') loadHome();
  if (page === 'speed') loadSpeed();
  if (page !== 'settings') stopMicTest();
}
document.querySelectorAll('.nav').forEach((b) => b.addEventListener('click', () => go(b.dataset.page)));
document.addEventListener('click', (e) => {
  const href = e.target.closest('[data-href]')?.dataset.href;
  if (href) api.invoke('open:external', href).catch((err) => toast(err.message, true));
  const to = e.target.closest('[data-goto]')?.dataset.goto;
  if (to) go(to);
});
api.on('nav', go);

// ---------- status ----------
let status = { state: 'idle', paused: false, hookOk: true };
function renderStatus() {
  // Only problems are shown here. When everything works the line is empty.
  const s = $('status');
  let state = '', text = '';
  if (!status.hookOk) { state = 'broken'; text = 'Shortcut not working'; }
  else if (settings && !settings.hasKey) { state = 'nokey'; text = 'Needs an OpenRouter key'; }
  else if (status.paused) { state = 'paused'; text = 'Shortcut paused'; }
  s.dataset.state = state;
  s.textContent = text;
  s.hidden = !text;
  $('heroKeys').classList.toggle('live', status.state === 'recording');
}
api.on('status', (s) => { status = s; renderStatus(); renderIssue(); });

const ISSUE_ACTIONS = {
  mic: ['Open Settings', () => go('settings')],
  key: ['Check key', () => go('settings')],
  credits: ['Add credits', () => api.invoke('open:external', 'https://openrouter.ai/settings/credits')],
  history: ['Open History', () => go('history')],
};
function renderIssue() {
  const issue = status.issue;
  $('issue').hidden = !issue || !settings?.hasKey;
  if (!issue) return;
  $('issueText').textContent = issue.message;
  const action = ISSUE_ACTIONS[issue.action];
  $('issueAction').hidden = !action;
  if (action) { $('issueAction').textContent = action[0]; $('issueAction').onclick = action[1]; }
}
$('issueDismiss').addEventListener('click', () => api.invoke('issue:dismiss'));

// ---------- home ----------
function renderHero() {
  if (!settings) return;
  $('heroKeys').replaceChildren(keycaps(settings.hotkeyLabel));
  const hold = settings.hotkeyMode === 'hold';
  $('heroTitle').textContent = hold ? 'Hold the keys and talk' : 'Press the keys and talk';
  const out = settings.outputMode === 'paste' ? 'the text is typed wherever your cursor is' : 'the text is copied so you can paste it';
  $('heroSub').textContent = hold ? `Let go and ${out}.` : `Press them again and ${out}.`;
  $('setup').hidden = settings.hasKey;
  $('homeReady').hidden = !settings.hasKey;
}

async function loadHome() {
  renderHero();
  try {
    const [st, items] = await Promise.all([api.invoke('stats'), api.invoke('history:list', '', 3)]);
    $('stToday').textContent = st.todayWords.toLocaleString();
    $('stWords').textContent = st.words.toLocaleString();
    $('stWpm').textContent = `${st.wpm} wpm`;
    $('stats').hidden = st.total === 0;
    $('stCost').textContent = `$${st.cost < 10 ? st.cost.toFixed(st.cost < 0.01 && st.cost > 0 ? 4 : 2) : st.cost.toFixed(2)}`;
    renderHistory($('recent'), items, 'Nothing yet. Your dictations show up here.');
  } catch (err) { toast(err.message, true); }
}

// After a dictation into the Try box, say what the AI did with it.
// r: { raw, final, style, aiError, cut } from main, sent right after each dictation.
function renderTryResult(r) {
  const box = $('tryResult');
  if ($('page-home').hidden || document.activeElement !== $('tryBox')) return;
  const name = STYLE_NAMES[r.style] || 'No AI';
  const cut = r.cut ? ` Cut to ${r.cut} characters.` : '';
  if (r.style === 'raw') box.replaceChildren((r.aiError ? 'AI cleanup failed, so you got the text as heard.' : 'AI cleanup is off, so you got the text as heard.') + cut);
  else if (r.raw === r.final) box.replaceChildren(`${name} found nothing to fix.${cut}`);
  else {
    const nodes = wordDiff(r.raw, r.final);
    const n = countChanges(nodes);
    const diff = el('p', { class: 'diff', hidden: true }, nodes);
    const btn = el('button', { class: 'link', type: 'button', 'aria-expanded': 'false', onclick: () => {
      diff.hidden = !diff.hidden; btn.setAttribute('aria-expanded', String(!diff.hidden)); btn.textContent = diff.hidden ? 'Show changes' : 'Hide changes';
    } }, 'Show changes');
    box.replaceChildren(`${name} made ${n} ${n === 1 ? 'change' : 'changes'}.${cut} `, btn, diff);
  }
  box.hidden = false;
}
api.on('dictation:done', renderTryResult);
$('tryClear').addEventListener('click', () => { $('tryBox').value = ''; $('tryResult').hidden = true; $('tryBox').focus(); });

$('setupForm').addEventListener('submit', (e) => { e.preventDefault(); saveKey($('setupKey'), $('setupMsg'), $('setupSave')); });

async function saveKey(input, msg, btn) {
  msg.textContent = ''; msg.className = 'form-msg';
  btn.disabled = true; btn.textContent = 'Checking…';
  try {
    const r = await api.invoke('key:set', input.value);
    settings = r.settings;
    input.value = '';
    toast('Key saved');
    keyEditing = false;
    keyInfoGen++;
    renderHero(); renderStatus(); renderIssue(); renderKey(r.info);
    if (!$('page-home').hidden) { loadHome(); $('tryBox').focus(); }
    return true;
  } catch (err) {
    msg.textContent = err.message;
    return false;
  } finally { btn.disabled = false; btn.textContent = 'Save key'; }
}

// ---------- speed test ----------
// Records in this window and cuts the audio into pieces at pauses. Main transcribes each piece while
// the user keeps talking, so the counts update during the test. Rates use the whole time recorded,
// pauses included: they say how much someone says in that time.
const AUDIO = window.JVoiceAudio;
const RATE = AUDIO.TARGET_RATE;
const LENGTH_PRESETS = [30, 60, 120, 300, 600, 1800, 3600, 0];
let speedRun = null;
let speedCustom = false; // Custom picked, even when its minutes match a preset
let speedRows = [];

function clock(sec) {
  const s = Math.max(0, Math.floor(sec)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}
// "1 min 30 sec", "1 hour", "45 sec"
function lengthName(sec) {
  const s = Math.round(sec), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const parts = [];
  if (h) parts.push(`${h} ${h === 1 ? 'hour' : 'hours'}`);
  if (m) parts.push(`${m} min`);
  if (r || !parts.length) parts.push(`${r} sec`);
  return parts.join(' ');
}
const num = (n) => Math.round(n).toLocaleString();
const perMin = (count, sec) => (sec > 0 ? count / (sec / 60) : 0);

function micError(err) {
  const name = err && err.name;
  return name === 'NotAllowedError' ? 'Microphone access is blocked. Allow it in Windows privacy settings.'
    : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'No microphone found. Pick one in Settings.'
    : name === 'NotReadableError' ? 'The microphone is busy in another app.'
    : `Could not start the microphone: ${err.message || err}`;
}

function speedLength() {
  const v = settings?.speedLength ?? 60;
  return speedCustom ? Math.min(180, Math.max(1, Math.round(Number($('speedCustom').value) || 1))) * 60 : v;
}
function renderSpeedSetup() {
  if (!settings) return;
  const v = settings.speedLength;
  if (!LENGTH_PRESETS.includes(v)) speedCustom = true;
  setRadio('[data-len]', 'len', speedCustom ? 'custom' : String(v));
  $('speedCustomRow').hidden = !speedCustom;
  if (document.activeElement !== $('speedCustom')) $('speedCustom').value = String(Math.max(1, Math.round((v || 900) / 60)));
  const len = speedLength();
  $('speedLenHelp').textContent = len ? `The test stops by itself after ${lengthName(len)}. You can stop early.` : 'The test runs until you press Stop.';
  $('speedStart').textContent = $('page-speed').dataset.state === 'done' ? 'Test again' : 'Start test';
}
document.querySelectorAll('[data-len]').forEach((b) => b.addEventListener('click', () => {
  if (speedRun) return;
  if (b.dataset.len === 'custom') {
    speedCustom = true;
    renderSpeedSetup();
    save({ speedLength: speedLength() }, true);
    $('speedCustom').focus();
    return;
  }
  speedCustom = false;
  save({ speedLength: Number(b.dataset.len) }, true).then(renderSpeedSetup);
}));
$('speedCustom').addEventListener('change', () => save({ speedLength: speedLength() }, true).then(renderSpeedSetup));

// idle: pick a length. starting: opening the mic. running. finishing: last pieces being counted.
// done: result shown above the setup.
function setSpeedView(state) {
  $('page-speed').dataset.state = state;
  const busy = ['starting', 'running', 'finishing'].includes(state);
  $('speedRun').hidden = !busy;
  $('speedSetup').hidden = busy;
  $('speedResult').hidden = state !== 'done';
  $('speedStop').disabled = state !== 'running';
  $('speedStop').textContent = state === 'finishing' ? 'Counting…' : 'Stop and see result';
  if (state === 'starting') {
    $('speedTime').textContent = clock(speedRun?.planned || 0);
    $('speedTimeLabel').textContent = 'Starting microphone';
    $('speedNote').textContent = '';
    $('speedHeard').textContent = '';
    for (const id of ['runWpm', 'runCpm']) $(id).textContent = '-';
    for (const id of ['runWords', 'runChars']) $(id).textContent = '0';
    $('speedBarFill').style.width = '0';
    $('speedBar').hidden = !speedRun?.planned;
  }
  if (state === 'finishing') $('speedNote').textContent = 'Counting the last words…';
  renderSpeedSetup();
}

function drawSpeed() {
  const r = speedRun;
  if (!r) return;
  const done = r.samples / RATE;
  if (r.planned) {
    $('speedTime').textContent = clock(Math.ceil(r.planned - done));
    $('speedTimeLabel').textContent = 'left';
    const pct = Math.min(100, (done / r.planned) * 100);
    $('speedBarFill').style.width = `${pct}%`;
    if (performance.now() - (r.saidAt || 0) > 1000) { r.saidAt = performance.now(); $('speedBar').setAttribute('aria-valuenow', String(Math.round(pct))); }
  } else {
    $('speedTime').textContent = clock(done);
    $('speedTimeLabel').textContent = 'so far';
  }
  $('speedLevel').style.transform = `scaleX(${Math.min(1, r.level * 9)})`;
  r.raf = requestAnimationFrame(drawSpeed);
}

function renderSpeedNums(r) {
  if (r !== speedRun) return;
  const sec = r.okSamples / RATE;
  // The rate shows once some speech is counted; a few seconds of audio would give a wild number.
  const ready = sec >= 5 && r.words > 0;
  $('runWpm').textContent = ready ? num(perMin(r.words, sec)) : '-';
  $('runCpm').textContent = ready ? num(perMin(r.chars, sec)) : '-';
  $('runWords').textContent = num(r.words);
  $('runChars').textContent = num(r.chars);
  const heard = r.texts.filter(Boolean).join(' ');
  $('speedHeard').textContent = heard.length > 320 ? `…${heard.slice(-320).replace(/^\S*\s/, '')}` : heard;
  if (r.state === 'running') {
    $('speedNote').textContent = r.lastError ? `Part of the recording could not be counted: ${r.lastError}`
      : r.words ? 'Counts update every few seconds as JVoice writes down what you said.'
      : 'Start talking. Counts show up a few seconds after you start.';
  }
}

async function startSpeedTest() {
  if (speedRun || !settings) return;
  if (!settings.hasKey) { toast('Add your OpenRouter key on Home first.', true); return; }
  const me = speedRun = {
    planned: speedLength(), state: 'starting', samples: 0, level: 0,
    seg: AUDIO.makeSegmenter(), next: 0, pending: [], inflight: 0, texts: [],
    words: 0, chars: 0, okSamples: 0, missedSamples: 0, cost: 0, lastError: '',
  };
  setSpeedView('starting');
  // The test starts with the first audio, not when the mic opens, so no word said before the audio
  // engine runs is lost. If no audio comes at all, the test gives up instead of waiting forever.
  me.noAudio = setTimeout(() => {
    if (speedRun !== me || me.state !== 'starting') return;
    failSpeedStart(me, 'The microphone is not sending any sound. Check the input device in Settings.');
    // The engine may be what is stuck, so the next start makes a new one.
    me.ctx?.close().catch(() => {});
    speedEngineP = null;
  }, 10000);
  try {
    await api.invoke('speed:active', true);
    const id = settings.micDeviceId;
    // Open the mic and start the audio engine at the same time; each can take a second or more.
    const [stream, ctx] = await Promise.all([
      navigator.mediaDevices.getUserMedia({
        audio: { deviceId: id ? { exact: id } : undefined, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      }).then((s) => {
        me.stream = s;
        if (speedRun !== me) s.getTracks().forEach((t) => t.stop()); // cancelled or failed meanwhile
        return s;
      }),
      speedEngine().then(async (c) => { me.ctx = c; await c.resume(); return c; }),
    ]);
    if (speedRun !== me) { closeSpeedMic(me); return; }
    me.resample = AUDIO.makeResampler(ctx.sampleRate, RATE);
    me.src = ctx.createMediaStreamSource(stream);
    me.node = new AudioWorkletNode(ctx, 'tap');
    me.node.port.onmessage = (e) => onSpeedAudio(me, e.data.flushed || e.data, !!e.data.flushed);
    me.src.connect(me.node);
    stream.getAudioTracks()[0].addEventListener('ended', () => finishSpeedTest(me, 'The microphone was disconnected, so the test ended early.'));
  } catch (err) {
    if (speedRun === me) failSpeedStart(me, err.name ? micError(err) : err.message);
  }
}

function failSpeedStart(me, message) {
  closeSpeedMic(me);
  speedRun = null;
  api.invoke('speed:active', false).catch(() => {});
  setSpeedView(speedHasResult ? 'done' : 'idle');
  toast(message, true);
}

function onSpeedAudio(me, buf, isFlush) {
  if (speedRun !== me) return;
  if (me.state === 'starting' && !isFlush) {
    clearTimeout(me.noAudio);
    me.state = 'running';
    setSpeedView('running');
    renderSpeedNums(me);
    me.raf = requestAnimationFrame(drawSpeed);
  }
  if (me.state === 'running' || isFlush) {
    let x = me.resample(buf);
    const limit = me.planned ? me.planned * RATE : Infinity;
    if (me.samples + x.length > limit) x = x.subarray(0, Math.max(0, limit - me.samples));
    if (x.length) {
      let sum = 0, pk = 0;
      for (let i = 0; i < x.length; i++) { const v = Math.abs(x[i]); sum += v * v; if (v > pk) pk = v; }
      const level = Math.sqrt(sum / x.length);
      me.level = me.level * 0.6 + level * 0.4;
      me.samples += x.length;
      const piece = me.seg.push(AUDIO.toInt16(x), level, pk);
      if (piece) sendPiece(me, piece);
    }
    if (me.state === 'running' && me.samples >= limit) finishSpeedTest(me);
  }
  if (isFlush) me.flushed?.();
}

function sendPiece(me, piece) {
  me.pending.push({ index: me.next++, ...piece });
  pumpPieces(me);
}
// Two pieces at a time: enough to keep up with speech, without flooding OpenRouter.
function pumpPieces(me) {
  while (me.inflight < 2 && me.pending.length && !me.fatal) {
    const p = me.pending.shift();
    me.inflight++;
    transcribePiece(me, p).finally(() => {
      me.inflight--;
      pumpPieces(me);
      if (!me.inflight && (!me.pending.length || me.fatal)) me.idle?.();
    });
  }
}
async function transcribePiece(me, p) {
  // A piece with no sound, or too short to hold a word, is a pause: it counts as time, not words.
  if (p.peak < 0.01 || p.samples < 0.35 * RATE) { me.okSamples += p.samples; renderSpeedNums(me); return; }
  const { wav } = AUDIO.encodeWav(p.chunks, RATE);
  p.chunks = null;
  let r;
  try { r = await api.invoke('speed:transcribe', wav); } catch (err) { r = { error: err.message }; }
  if (speedRun !== me) return;
  if (r.error) {
    me.missedSamples += p.samples;
    me.lastError = r.error;
    if (r.fatal && !me.fatal) { me.fatal = r.error; finishSpeedTest(me, r.error); }
  } else {
    me.okSamples += p.samples;
    me.words += r.words; me.chars += r.chars; me.cost += r.cost;
    me.texts[p.index] = r.text;
  }
  renderSpeedNums(me);
}

function closeSpeedMic(me) {
  cancelAnimationFrame(me.raf);
  clearTimeout(me.noAudio);
  try { me.src?.disconnect(); me.node?.disconnect(); } catch { /* already gone */ }
  if (me.node) { me.node.port.postMessage('dispose'); me.node.port.onmessage = null; }
  me.stream?.getTracks().forEach((t) => t.stop());
  me.ctx?.suspend().catch(() => {}); // kept for the next test; a running context keeps Windows awake
}

// One audio engine with the worklet loaded, made when the Speed test page first opens and kept
// suspended between tests. Making it at Start took a few seconds before the first audio arrived.
let speedEngineP = null;
function speedEngine() {
  if (!speedEngineP) {
    speedEngineP = (async () => {
      let c;
      try { c = new AudioContext({ sampleRate: RATE }); } catch { c = new AudioContext(); }
      const url = URL.createObjectURL(new Blob([AUDIO.WORKLET], { type: 'application/javascript' }));
      try { await c.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
      if (!speedRun) await c.suspend();
      return c;
    })();
    speedEngineP.catch(() => { speedEngineP = null; }); // try again at the next start
  }
  return speedEngineP;
}

async function finishSpeedTest(me, error = '') {
  if (speedRun !== me || me.state === 'finishing') return;
  me.state = 'finishing';
  // Collect the last fraction of a second the worklet still holds, then close the mic.
  if (me.node && !error) await new Promise((res) => { me.flushed = res; me.node.port.postMessage('flush'); setTimeout(res, 300); });
  if (speedRun !== me) return;
  closeSpeedMic(me);
  const last = me.seg.flush();
  if (last) sendPiece(me, last);
  setSpeedView('finishing');
  await new Promise((res) => { if (!me.inflight && (!me.pending.length || me.fatal)) res(); else me.idle = res; });
  if (speedRun !== me) return;
  // Pieces never sent after a key or credit problem did not get counted.
  for (const p of me.pending.splice(0)) me.missedSamples += p.samples;
  const seconds = me.okSamples / RATE, missed = me.missedSamples / RATE;
  const transcript = me.texts.filter(Boolean).join(' ');
  speedRun = null;
  let row = null, saveError = '';
  if (me.words) {
    try { row = await api.invoke('speed:save', { planned: me.planned, seconds, missed, transcript, cost: me.cost }); } catch (err) { saveError = err.message; }
  }
  api.invoke('speed:active', false).catch(() => {});
  if (!row) {
    setSpeedView(speedHasResult ? 'done' : 'idle');
    toast(error || saveError || (missed ? `Nothing could be counted. ${me.lastError}` : 'No speech was heard. Check your microphone in Settings.'), true);
    return;
  }
  const warn = [];
  if (error) warn.push(error);
  if (missed >= 1) warn.push(`${lengthName(missed)} of the recording could not be transcribed, so the rates use the other ${lengthName(seconds)}.${me.lastError && !error ? ` ${me.lastError}` : ''}`);
  if (seconds < 15) warn.push('Short tests are less accurate. Try a minute or more.');
  showSpeedResult(row, warn.join(' '));
  loadSpeedList();
}

let speedHasResult = false;
function showSpeedResult(row, warn = '') {
  speedHasResult = true;
  const best = Math.max(...speedRows.map((r) => r.wpm)); // the earlier results; this one is not in the list yet
  $('speedResultTitle').textContent = speedRows.length && row.wpm > best ? 'Your result, a new best' : 'Your result';
  $('speedResultMeta').textContent = `${lengthName(row.seconds + row.missed_seconds)} of talking`;
  $('resWpm').textContent = num(row.wpm);
  $('resCpm').textContent = num(row.cpm);
  $('resWords').textContent = num(row.words);
  $('resChars').textContent = num(row.chars);
  $('speedResultWarn').textContent = warn;
  $('speedResultWarn').hidden = !warn;
  $('speedTranscript').textContent = row.transcript;
  $('speedTranscript').hidden = true;
  $('speedTextToggle').setAttribute('aria-expanded', 'false');
  $('speedTextToggle').textContent = 'Show what JVoice heard';
  $('speedCopy').onclick = async () => {
    await api.invoke('clipboard:write', `${num(row.wpm)} words per minute, ${num(row.cpm)} characters per minute (${num(row.words)} words in ${lengthName(row.seconds)})`);
    toast('Copied');
  };
  setSpeedView('done');
}
$('speedTextToggle').addEventListener('click', (e) => {
  const t = $('speedTranscript');
  t.hidden = !t.hidden;
  e.currentTarget.setAttribute('aria-expanded', String(!t.hidden));
  e.currentTarget.textContent = t.hidden ? 'Show what JVoice heard' : 'Hide what JVoice heard';
});

function cancelSpeedTest() {
  const me = speedRun;
  if (!me) return;
  speedRun = null;
  closeSpeedMic(me);
  api.invoke('speed:active', false).catch(() => {}); // also stops pieces still being transcribed
  setSpeedView(speedHasResult ? 'done' : 'idle');
}

$('speedStart').addEventListener('click', startSpeedTest);
$('speedStop').addEventListener('click', () => { if (speedRun?.state === 'running') finishSpeedTest(speedRun); });
$('speedCancel').addEventListener('click', cancelSpeedTest);

function speedItem(row, best) {
  const text = el('div', { class: 'item-text', hidden: true }, row.transcript);
  const toggle = el('button', { class: 'btn ghost sm', type: 'button', 'aria-expanded': 'false', onclick: (e) => {
    text.hidden = !text.hidden;
    e.currentTarget.setAttribute('aria-expanded', String(!text.hidden));
    e.currentTarget.textContent = text.hidden ? 'Show text' : 'Hide text';
  } }, 'Show text');
  const actions = el('div', { class: 'item-actions' }, toggle,
    el('button', { class: 'btn ghost icon sm', type: 'button', title: 'Delete', 'aria-label': 'Delete result', onclick: async () => {
      try { await api.invoke('speed:delete', row.id); loadSpeedList(); } catch (err) { toast(err.message, true); }
    } }, svg(ICONS.trash)));
  const length = row.planned_seconds ? lengthName(row.seconds + row.missed_seconds) : `${lengthName(row.seconds + row.missed_seconds)}, no limit`;
  return el('li', { class: 'item' },
    el('div', { class: 'item-meta' },
      el('span', {}, when(row.created_at)), el('span', {}, '·'), el('span', {}, length),
      best ? el('span', { class: 'tag best' }, 'Best') : null,
      actions),
    el('div', { class: 'speed-row' },
      el('span', {}, el('b', {}, num(row.wpm)), ' words per minute'),
      el('span', {}, el('b', {}, num(row.cpm)), ' characters per minute'),
      el('span', { class: 'muted' }, `${num(row.words)} words, ${num(row.chars)} characters`)),
    text);
}
async function loadSpeedList() {
  try {
    speedRows = await api.invoke('speed:list');
    const best = speedRows.length > 1 ? Math.max(...speedRows.map((r) => r.wpm)) : -1;
    const bestId = speedRows.find((r) => r.wpm === best)?.id;
    $('speedList').replaceChildren(...speedRows.map((r) => speedItem(r, r.id === bestId)));
    $('speedPastHead').hidden = !speedRows.length;
  } catch (err) { toast(err.message, true); }
}
function loadSpeed() {
  if (!speedRun) setSpeedView(speedHasResult ? 'done' : 'idle');
  speedEngine().catch(() => {});
  loadSpeedList();
}

// ---------- history ----------
function historyItem(row) {
  const failed = row.status === 'failed';
  const text = failed ? null : el('div', { class: 'item-text' }, row.final);
  const actions = el('div', { class: 'item-actions' });
  if (failed) {
    actions.append(el('button', { class: 'btn sm', type: 'button', onclick: async (e) => {
      const b = e.currentTarget; b.disabled = true; b.lastChild.textContent = 'Retrying…';
      try { const r = await api.invoke('history:retry', row.id); toast(r.final ? 'Done. Text copied to the clipboard.' : 'No speech found in this recording.'); }
      catch (err) { toast(err.message, true); }
      refreshLists();
    } }, svg(ICONS.retry), el('span', {}, 'Retry')));
  } else {
    actions.append(el('button', { class: 'btn ghost icon sm', type: 'button', title: 'Copy', 'aria-label': 'Copy text', onclick: async () => {
      await api.invoke('clipboard:write', row.final); toast('Copied');
    } }, svg(ICONS.copy)));
    if (row.raw && row.raw !== row.final) {
      let shown = false;
      actions.prepend(el('button', { class: 'btn ghost sm', type: 'button', onclick: (e) => {
        shown = !shown;
        text.replaceChildren(...(shown ? wordDiff(row.raw, row.final) : [row.final]));
        text.classList.toggle('diff', shown);
        e.currentTarget.textContent = shown ? 'Hide changes' : 'Show changes';
      } }, 'Show changes'));
    }
  }
  actions.append(el('button', { class: 'btn ghost icon sm', type: 'button', title: 'Delete', 'aria-label': 'Delete entry', onclick: async () => {
    await api.invoke('history:delete', row.id); refreshLists();
  } }, svg(ICONS.trash)));

  const meta = el('div', { class: 'item-meta' },
    el('span', {}, when(row.created_at)),
    el('span', {}, '·'), el('span', {}, secs(row.duration_ms)),
    failed ? el('span', { class: 'tag failed' }, 'Failed') : el('span', { class: 'tag' }, styleName(row)),
    !failed && row.ai_model && row.raw === row.final ? el('span', { class: 'tag' }, 'No changes needed') : null,
    !failed && row.ai_model ? el('span', {}, shortModel(row.ai_model)) : null,
    !failed && row.cut ? el('span', { class: 'tag' }, `Cut to ${row.cut}`) : null,
    !failed ? el('span', {}, `${row.words} words`) : null,
    actions);
  return el('li', { class: `item${failed ? ' failed' : ''}` }, meta,
    failed ? el('div', { class: 'item-err' }, row.error) : text,
    !failed && row.error ? el('div', { class: 'item-warn' }, row.error) : null);
}

function renderHistory(list, rows, emptyText) {
  list.replaceChildren(...(rows.length ? rows.map(historyItem) : [el('li', { class: 'empty' }, emptyText)]));
}

let searchTimer;
async function loadHistory() {
  try {
    const q = $('histSearch').value;
    const rows = await api.invoke('history:list', q);
    renderHistory($('histList'), rows, q ? 'No matches.' : 'No dictations yet. Use your shortcut in any app to start.');
    $('histClear').hidden = !rows.length && !q;
  } catch (err) { toast(err.message, true); }
}
$('histSearch').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadHistory, 150); });
$('histClear').addEventListener('click', async () => {
  if (!await confirmBox('Clear all history?', 'This deletes every saved dictation on this computer. It cannot be undone.', 'Clear history')) return;
  await api.invoke('history:clear');
  toast('History cleared');
  refreshLists();
});
function refreshLists() {
  if (!$('page-history').hidden) loadHistory();
  if (!$('page-home').hidden) loadHome();
}
// While the window is hidden there is nothing to redraw; catch up when it is shown again.
let listsStale = false;
api.on('history:changed', () => { if (document.hidden) listsStale = true; else refreshLists(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && listsStale) { listsStale = false; refreshLists(); } });

// ---------- dictionary ----------
let editingId = null;
async function loadDictionary() {
  try { renderDictionary(await api.invoke('dict:list')); } catch (err) { toast(err.message, true); }
}
function renderDictionary(rows) {
  $('dictEmpty').hidden = rows.length > 0;
  $('dictList').replaceChildren(...rows.map((r) => el('li', {},
    el('span', { class: 'term' }, r.term),
    el('span', { class: 'heard' }, r.heard_as ? `heard as ${r.heard_as}` : ''),
    el('button', { class: 'btn ghost icon sm', type: 'button', title: 'Edit', 'aria-label': `Edit ${r.term}`, onclick: () => {
      editingId = r.id; $('dictTerm').value = r.term; $('dictHeard').value = r.heard_as; $('dictSubmit').textContent = 'Save';
      $('dictCancel').hidden = false; $('dictEditing').hidden = false; $('dictEditing').textContent = `Editing ${r.term}`;
      $('dictTerm').focus();
    } }, svg(ICONS.edit)),
    el('button', { class: 'btn ghost icon sm', type: 'button', title: 'Delete', 'aria-label': `Delete ${r.term}`, onclick: async () => {
      renderDictionary(await api.invoke('dict:delete', r.id));
      if (editingId === r.id) resetDictForm();
    } }, svg(ICONS.trash)))));
}
function resetDictForm() {
  editingId = null; $('dictForm').reset(); $('dictSubmit').textContent = 'Add';
  $('dictCancel').hidden = true; $('dictEditing').hidden = true; $('dictMsg').textContent = '';
}
$('dictCancel').addEventListener('click', resetDictForm);
$('dictForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('dictMsg').textContent = '';
  try {
    renderDictionary(await api.invoke('dict:save', { id: editingId, term: $('dictTerm').value, heard_as: $('dictHeard').value }));
    resetDictForm();
    $('dictTerm').focus();
  } catch (err) { $('dictMsg').textContent = err.message; }
});

// ---------- settings ----------
async function save(patch, quiet = false) {
  try {
    settings = await api.invoke('settings:set', patch);
    renderSettings(); renderHero(); renderStatus();
    if (!quiet) toast('Saved');
  } catch (err) { toast(err.message, true); renderSettings(); }
}

let keyEditing = false;
function renderKey(info) {
  const editing = !settings.hasKey || keyEditing;
  $('keyView').hidden = editing;
  $('keyForm').hidden = !editing;
  $('keyCancel').hidden = !settings.hasKey;
  $('keyMasked').textContent = settings.keyMasked;
  if (info === undefined) return;
  if (!info) { $('keyInfo').textContent = ''; return; }
  const parts = [];
  if (info.label) parts.push(info.label);
  parts.push(info.limit != null ? `$${info.usage.toFixed(2)} of $${info.limit.toFixed(2)} used` : `$${info.usage.toFixed(2)} used`);
  $('keyInfo').textContent = parts.join(' · ');
}
let keyInfoGen = 0;
async function loadKeyInfo() {
  const gen = ++keyInfoGen;
  if (!settings?.hasKey) return renderKey(null);
  $('keyInfo').textContent = 'Checking key…';
  try {
    const info = await api.invoke('key:info');
    if (gen === keyInfoGen) renderKey(info);
  } catch (err) { if (gen === keyInfoGen) $('keyInfo').textContent = err.message; }
}
$('keyChange').addEventListener('click', () => { keyEditing = true; renderKey(); $('keyInput').focus(); });
$('keyCancel').addEventListener('click', () => { keyEditing = false; $('keyMsg').textContent = ''; $('keyInput').value = ''; renderKey(); });
$('keyForm').addEventListener('submit', async (e) => { e.preventDefault(); await saveKey($('keyInput'), $('keyMsg'), $('keySave')); });
$('keyRemove').addEventListener('click', async () => {
  if (!await confirmBox('Remove your key?', 'JVoice cannot transcribe until you add a key again.', 'Remove key')) return;
  settings = await api.invoke('key:clear');
  keyEditing = false;
  keyInfoGen++;
  renderKey(null); renderHero(); renderStatus(); renderIssue();
});

const LANGS = [['', 'Auto detect'], ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'], ['pl', 'Polish'], ['ru', 'Russian'], ['uk', 'Ukrainian'], ['tr', 'Turkish'], ['ar', 'Arabic'], ['he', 'Hebrew'], ['hi', 'Hindi'], ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese'], ['sv', 'Swedish'], ['da', 'Danish'], ['no', 'Norwegian'], ['fi', 'Finnish'], ['cs', 'Czech'], ['el', 'Greek'], ['id', 'Indonesian'], ['vi', 'Vietnamese'], ['th', 'Thai']];
$('language').append(...LANGS.map(([v, n]) => el('option', { value: v }, n)));

function setRadio(selector, attr, value) {
  document.querySelectorAll(selector).forEach((b) => {
    b.setAttribute('aria-checked', String(b.dataset[attr] === value));
    b.tabIndex = b.dataset[attr] === value ? 0 : -1; // one Tab stop per group; arrows move inside it
  });
}
function radioKeys(group) {
  // Arrow keys move between options in a radio group.
  group.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    const items = [...group.querySelectorAll('[role="radio"]')];
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const next = items[(i + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? items.length - 1 : 1)) % items.length];
    next.focus(); next.click();
  });
}
document.querySelectorAll('[role="radiogroup"]').forEach(radioKeys);

function renderSettings() {
  if (!settings) return;
  renderKey();
  $('hkKeys').replaceChildren(keycaps(settings.hotkeyLabel));
  setRadio('[data-mode]', 'mode', settings.hotkeyMode);
  $('hkHelp').textContent = settings.hotkeyMode === 'hold' ? 'Hold to record, let go to finish. Esc cancels.' : 'Press once to start, again to finish. Esc cancels.';
  const stt = $('sttModel');
  if (![...stt.options].some((o) => o.value === settings.sttModel)) stt.append(el('option', { value: settings.sttModel }, settings.sttModel));
  stt.value = settings.sttModel;
  $('language').value = settings.language;
  $('aiEnabled').checked = settings.aiEnabled;
  $('aiBody').classList.toggle('off', !settings.aiEnabled);
  $('aiBody').toggleAttribute('inert', !settings.aiEnabled);
  setRadio('[data-style]', 'style', settings.aiStyle);
  if (document.activeElement !== $('aiCustom')) $('aiCustom').value = settings.aiCustomPrompt;
  renderModelPick();
  setRadio('[data-output]', 'output', settings.outputMode);
  $('restoreClipboard').checked = settings.restoreClipboard;
  $('restoreClipboard').disabled = settings.outputMode !== 'paste';
  $('restoreHelp').textContent = settings.outputMode === 'paste' ? 'Puts back what you had copied after pasting.' : 'Not used in Copy only mode, since the text has to stay on the clipboard.';
  $('sounds').checked = settings.sounds;
  $('charLimit').value = String(settings.charLimit);
  $('launchAtLogin').checked = settings.launchAtLogin;
  $('keepHistory').checked = settings.keepHistory;
  $('maxRecord').value = String(settings.maxRecordSeconds);
}

document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => save({ hotkeyMode: b.dataset.mode })));
document.querySelectorAll('[data-style]').forEach((b) => b.addEventListener('click', () => save({ aiStyle: b.dataset.style })));
document.querySelectorAll('[data-output]').forEach((b) => b.addEventListener('click', () => save({ outputMode: b.dataset.output })));
for (const id of ['aiEnabled', 'restoreClipboard', 'sounds', 'launchAtLogin', 'keepHistory']) {
  $(id).addEventListener('change', (e) => save({ [id]: e.target.checked }));
}
$('sttModel').addEventListener('change', (e) => save({ sttModel: e.target.value }));
$('language').addEventListener('change', (e) => save({ language: e.target.value }));
$('maxRecord').addEventListener('change', (e) => save({ maxRecordSeconds: Number(e.target.value) }));
$('charLimit').addEventListener('change', (e) => save({ charLimit: Number(e.target.value) }));
// Saved as you type, so the very next dictation already follows the new instructions.
let customTimer;
function saveCustom(v) {
  clearTimeout(customTimer);
  if (v === settings.aiCustomPrompt) return;
  $('customSaved').textContent = 'Saving…';
  save({ aiCustomPrompt: v }, true).then(() => { $('customSaved').textContent = settings.aiCustomPrompt === v ? 'Saved. Your next dictation uses it.' : ''; });
}
$('aiCustom').addEventListener('input', (e) => { clearTimeout(customTimer); $('customSaved').textContent = ''; customTimer = setTimeout(() => saveCustom(e.target.value), 300); });
$('aiCustom').addEventListener('change', (e) => saveCustom(e.target.value));
// Fast, cheap models that clean up dictation well (each tested end to end), plus "Other" to search all of them.
const RECOMMENDED = [
  ['DeepSeek', 'deepseek/deepseek-v4.1-flash', 'DeepSeek V4.1 Flash (default)'],
  ['DeepSeek', 'deepseek/deepseek-v4-flash', 'DeepSeek V4 Flash'],
  ['DeepSeek', 'deepseek/deepseek-v4-pro', 'DeepSeek V4 Pro'],
  ['Anthropic', 'anthropic/claude-haiku-5.5', 'Claude Haiku 5.5'],
  ['Google', 'google/gemini-3.8-flash', 'Gemini 3.8 Flash'],
  ['Google', 'google/gemini-3.1-flash-lite', 'Gemini 3.1 Flash Lite'],
  ['OpenAI', 'openai/gpt-5.4-mini', 'GPT-5.4 Mini'],
  ['OpenAI', 'openai/gpt-5.4-nano', 'GPT-5.4 Nano'],
  ['Qwen', 'qwen/qwen3.8-flash', 'Qwen3.8 Flash'],
  ['Mistral', 'mistralai/mistral-small-2603', 'Mistral Small 4'],
  ['Moonshot', 'moonshotai/kimi-k2.6', 'Kimi K2.6'],
];
const OTHER = '__other';
let pickOther = false;
function renderModelPick() {
  const sel = $('aiModelPreset');
  const avail = RECOMMENDED.filter(([, id]) => !models.length || models.some((m) => m.id === id));
  const groups = [...new Set(avail.map(([g]) => g))].map((g) => el('optgroup', { label: g },
    avail.filter(([x]) => x === g).map(([, id, name]) => el('option', { value: id }, name))));
  sel.replaceChildren(...groups, el('option', { value: OTHER }, 'Other model…'));
  if (!avail.some(([, id]) => id === settings.aiModel)) pickOther = true;
  sel.value = pickOther ? OTHER : settings.aiModel;
  $('aiModelOther').hidden = !pickOther;
  if (document.activeElement !== $('aiModel')) $('aiModel').value = settings.aiModel;
  renderPrice();
}
$('aiModelPreset').addEventListener('change', (e) => {
  if (e.target.value === OTHER) {
    pickOther = true; renderModelPick(); loadModels();
    $('aiModel').value = ''; $('aiModel').focus();
    return;
  }
  pickOther = false;
  save({ aiModel: e.target.value });
});
$('aiModel').addEventListener('change', (e) => {
  const v = e.target.value.trim();
  if (!v) { e.target.value = settings.aiModel; return; }
  if (models.length && !models.some((m) => m.id === v)) { toast(`${v} is not an OpenRouter model id.`, true); return; }
  save({ aiModel: v });
});
$('aiModel').addEventListener('input', renderPrice);
$('aiModel').addEventListener('blur', (e) => {
  if (!e.target.value.trim() && RECOMMENDED.some(([, id]) => id === settings.aiModel)) { pickOther = false; renderModelPick(); }
});

let modelsState = 'idle'; // idle | loading | ready | error
let modelsError = '';
function renderPrice() {
  $('aiModelRetry').hidden = modelsState !== 'error';
  if (modelsState === 'error') { $('aiPrice').textContent = `Could not load the model list: ${modelsError}`; return; }
  const typed = !$('aiModelOther').hidden && $('aiModel').value.trim();
  const m = models.find((x) => x.id === (typed || settings.aiModel));
  if (!m) { $('aiPrice').textContent = modelsState === 'loading' ? 'Loading models…' : 'Type to search every OpenRouter chat model.'; return; }
  const per = (p) => `$${(p * 1e6).toFixed(2)}`;
  const price = `${per(m.prompt)} in, ${per(m.completion)} out per million tokens.`;
  $('aiPrice').textContent = pickOther ? `${m.name}. ${price}` : price; // the preset list already names it
}
async function loadModels(force = false) {
  if (modelsState === 'loading' || (modelsState === 'ready' && !force)) return renderPrice();
  modelsState = 'loading'; renderPrice();
  try {
    models = await api.invoke('models:list', force);
    $('aiModels').replaceChildren(...models.map((m) => el('option', { value: m.id }, m.name)));
    $('aiModel').placeholder = `Search ${models.length} models`;
    modelsState = 'ready';
    if (settings) renderModelPick();
  } catch (err) { modelsState = 'error'; modelsError = err.message; }
  renderPrice();
}
$('aiModelRetry').addEventListener('click', () => loadModels(true));

// Shortcut capture
let capturedCombo = null;
$('hkChange').addEventListener('click', async () => {
  capturedCombo = null;
  $('hkCapture').replaceChildren(el('span', { class: 'placeholder' }, 'Waiting for keys'));
  $('hkMsg').textContent = '';
  $('hkSave').disabled = true;
  try { await api.invoke('hotkey:capture', true); } catch (err) { toast(err.message, true); return; }
  hkListening = true;
  $('hkDialog').showModal();
});
api.on('hotkey:capture', (c) => {
  if (!$('hkDialog').open) return;
  $('hkCapture').replaceChildren(c.held.length ? keycaps(c.held, true) : el('span', { class: 'placeholder' }, 'Waiting for keys'));
  if (!c.done) return;
  $('hkMsg').textContent = c.error || '';
  capturedCombo = c.error ? null : c.combo;
  $('hkSave').disabled = !capturedCombo;
  hkListening = !capturedCombo;
  if (capturedCombo) $('hkSave').focus();
  else api.invoke('hotkey:capture', true); // listen again
});
// While listening for a combo, keys must not act on the dialog (Space would press a button).
// Esc still closes it, and once a combo is captured the buttons work normally again.
let hkListening = false;
$('hkDialog').addEventListener('keydown', (e) => {
  if (!hkListening || e.key === 'Escape' || e.key === 'Tab') return;
  const plain = !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey;
  if (plain && (e.key === 'Enter' || e.key === ' ') && e.target.closest('button')) return;
  e.preventDefault();
});
$('hkCancel').addEventListener('click', () => $('hkDialog').close());
$('hkSave').addEventListener('click', async () => { if (capturedCombo) { await save({ hotkey: capturedCombo }); $('hkDialog').close(); } });
$('hkDialog').addEventListener('close', () => { hkListening = false; api.invoke('hotkey:capture', false); });

// Microphone list and test meter
let micTest = null;
async function loadMics() {
  const sel = $('micSelect');
  try {
    // Labels are only visible after access was granted once.
    let devices = await navigator.mediaDevices.enumerateDevices();
    if (!devices.some((d) => d.kind === 'audioinput' && d.label)) {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
    }
    const mics = devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
    sel.replaceChildren(el('option', { value: '' }, 'Windows default'), ...mics.map((d, i) => el('option', { value: d.deviceId }, d.label || `Microphone ${i + 1}`)));
    sel.value = mics.some((d) => d.deviceId === settings.micDeviceId) ? settings.micDeviceId : '';
    $('micHelp').textContent = mics.length ? '' : 'No microphone found.';
  } catch (err) {
    sel.replaceChildren(el('option', { value: '' }, 'Windows default'));
    $('micHelp').replaceChildren('Microphone access is blocked. ', el('button', { class: 'link', type: 'button', onclick: () => api.invoke('open:mic-settings') }, 'Open Windows privacy settings'));
  }
}
navigator.mediaDevices.addEventListener('devicechange', () => { if (!$('page-settings').hidden) loadMics(); });
$('micSelect').addEventListener('change', (e) => {
  save({ micDeviceId: e.target.value });
  const wasTesting = !!micTest || micStarting;
  stopMicTest();
  if (wasTesting) startMicTest();
});
document.addEventListener('visibilitychange', () => { if (document.hidden) stopMicTest(); });

let micGen = 0;
let micStarting = false;
async function startMicTest() {
  if (micTest) return;
  const gen = ++micGen;
  micStarting = true;
  $('micTest').disabled = true;
  try {
    const id = $('micSelect').value;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: id ? { deviceId: { exact: id } } : true });
    if (gen !== micGen || $('page-settings').hidden) { stream.getTracks().forEach((t) => t.stop()); return; }
    const ctx = new AudioContext();
    const an = ctx.createAnalyser(); an.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(an);
    const data = new Float32Array(an.fftSize);
    const test = micTest = { stream, ctx, raf: 0 };
    const tick = () => {
      if (micTest !== test) return;
      an.getFloatTimeDomainData(data);
      let s = 0; for (const v of data) s += v * v;
      const level = Math.min(100, Math.sqrt(s / data.length) * 900);
      $('micMeter').style.width = `${level}%`;
      if (performance.now() - (test.said || 0) > 250) { test.said = performance.now(); $('micMeterWrap').setAttribute('aria-valuenow', String(Math.round(level))); }
      test.raf = requestAnimationFrame(tick);
    };
    tick();
    $('micTest').textContent = 'Stop test';
  } catch (err) {
    if (gen === micGen) toast(err.name === 'NotAllowedError' ? 'Microphone access is blocked.' : `Could not open the microphone: ${err.message}`, true);
  } finally { if (gen === micGen) { micStarting = false; $('micTest').disabled = false; } }
}
function stopMicTest() {
  micGen++;
  micStarting = false;
  $('micTest').disabled = false;
  if (!micTest) return;
  cancelAnimationFrame(micTest.raf);
  micTest.stream.getTracks().forEach((t) => t.stop());
  micTest.ctx.close();
  micTest = null;
  $('micMeter').style.width = '0';
  $('micMeterWrap').setAttribute('aria-valuenow', '0');
  $('micTest').textContent = 'Start test';
}
$('micTest').addEventListener('click', () => (micTest ? stopMicTest() : startMicTest()));

// ---------- updates ----------
let update = { status: 'dev' };
function renderUpdate() {
  const s = update;
  $('updVersion').textContent = `Version ${s.version || ''}`.trim();
  const text = {
    dev: 'This is a development copy. It can check for new releases but only the installed app updates itself.',
    idle: '',
    checking: 'Checking for updates…',
    current: 'JVoice is up to date.',
    available: `Version ${s.next} is out. This copy cannot update itself, so download the installer from GitHub.`,
    downloading: `Downloading version ${s.next}… ${s.percent || 0}%`,
    verifying: 'Checking that the update comes from JVoice…',
    ready: `Version ${s.next} is ready. JVoice restarts when you finish dictating.`,
    restarting: `Restarting into version ${s.next}…`,
    error: s.error || 'The update check failed.',
  }[s.status] ?? '';
  $('updStatus').textContent = text;
  const btn = $('updAction');
  btn.textContent = s.status === 'ready' || s.status === 'restarting' ? 'Restart now' : s.status === 'available' ? 'Download' : 'Check for updates';
  btn.disabled = ['checking', 'downloading'].includes(s.status);
  btn.classList.toggle('primary', s.status === 'ready' || s.status === 'available');
  // Notes of the version on its way, or of the one just installed.
  const coming = ['downloading', 'verifying', 'ready', 'restarting'].includes(s.status) && s.notes;
  const notes = coming ? s.notes : s.justUpdated?.notes;
  const lines = (notes || '').split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2));
  $('updNotes').hidden = !lines.length;
  $('updNotesTitle').textContent = coming ? `Coming in version ${s.next}` : `What's new in version ${s.justUpdated?.version}`;
  $('updNotesList').replaceChildren(...lines.map((l) => el('li', {}, l)));
}
$('updAction').addEventListener('click', () => {
  if (update.status === 'ready' || update.status === 'restarting') api.invoke('update:restart');
  else if (update.status === 'available') api.invoke('open:external', update.url).catch((err) => toast(err.message, true));
  else api.invoke('update:check').catch((err) => toast(err.message, true));
});
api.on('update', (s) => { update = s; renderUpdate(); });

// ---------- boot ----------
(async () => {
  try {
    const [s, st, info, up] = await Promise.all([api.invoke('settings:get'), api.invoke('status'), api.invoke('app:info'), api.invoke('update:state')]);
    settings = s; status = st; update = up;
    renderUpdate();
    $('ver').textContent = `Version ${info.version}`;
    if (!info.packaged) $('loginHelp').textContent = 'Available in the installed app.';
    $('launchAtLogin').disabled = !info.packaged;
    renderStatus();
    renderIssue();
    go('home');
  } catch (err) { toast(err.message, true); }
})();
