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
  eye: '<path d="M2.5 10s2.8-5 7.5-5 7.5 5 7.5 5-2.8 5-7.5 5-7.5-5-7.5-5z"/><circle cx="10" cy="10" r="2"/>',
  edit: '<path d="M12.5 4.5l3 3L8 15H5v-3z"/>',
};

let toastTimer;
function toast(msg, err = false) {
  const t = $('toast');
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
const STYLE_NAMES = { clean: 'Light cleanup', intent: 'Intent', custom: 'Custom', raw: 'Raw' };

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
  const s = $('status');
  let state = status.state, text = 'Ready';
  if (!status.hookOk) { state = 'broken'; text = 'Shortcut not working'; }
  else if (settings && !settings.hasKey) { state = 'nokey'; text = 'Needs an OpenRouter key'; }
  else if (status.state === 'recording') text = 'Listening';
  else if (status.state === 'processing') text = 'Working';
  else if (status.paused) { state = 'paused'; text = 'Shortcut paused'; }
  s.dataset.state = state;
  $('statusText').textContent = text;
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
    const [st, items] = await Promise.all([api.invoke('stats'), api.invoke('history:list')]);
    $('stToday').textContent = st.todayWords.toLocaleString();
    $('stWords').textContent = st.words.toLocaleString();
    $('stWpm').textContent = `${st.wpm} wpm`;
    $('stats').hidden = st.total === 0;
    $('stCost').textContent = `$${st.cost < 10 ? st.cost.toFixed(st.cost < 0.01 && st.cost > 0 ? 4 : 2) : st.cost.toFixed(2)}`;
    renderHistory($('recent'), items.slice(0, 3), 'Nothing yet. Your dictations show up here.');
  } catch (err) { toast(err.message, true); }
}
$('tryClear').addEventListener('click', () => { $('tryBox').value = ''; $('tryBox').focus(); });

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

// ---------- history ----------
function historyItem(row) {
  const failed = row.status === 'failed';
  const raw = el('div', { class: 'item-raw', hidden: true }, row.raw || '');
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
      actions.append(el('button', { class: 'btn ghost icon sm', type: 'button', title: 'Show what was heard', 'aria-label': 'Show what was heard', 'aria-pressed': 'false', onclick: (e) => {
        raw.hidden = !raw.hidden; e.currentTarget.setAttribute('aria-pressed', String(!raw.hidden));
      } }, svg(ICONS.eye)));
    }
  }
  actions.append(el('button', { class: 'btn ghost icon sm', type: 'button', title: 'Delete', 'aria-label': 'Delete entry', onclick: async () => {
    await api.invoke('history:delete', row.id); refreshLists();
  } }, svg(ICONS.trash)));

  const meta = el('div', { class: 'item-meta' },
    el('span', {}, when(row.created_at)),
    el('span', {}, '·'), el('span', {}, secs(row.duration_ms)),
    failed ? el('span', { class: 'tag failed' }, 'Failed') : el('span', { class: 'tag' }, STYLE_NAMES[row.style] || row.style),
    !failed ? el('span', {}, `${row.words} words`) : null,
    actions);
  return el('li', { class: `item${failed ? ' failed' : ''}` }, meta,
    failed ? el('div', { class: 'item-err' }, row.error) : el('div', { class: 'item-text' }, row.final),
    !failed && row.error ? el('div', { class: 'item-warn' }, row.error) : null,
    raw.textContent ? raw : null);
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
api.on('history:changed', refreshLists);

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
  document.querySelectorAll(selector).forEach((b) => b.setAttribute('aria-checked', String(b.dataset[attr] === value)));
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
  const custom = settings.aiStyle === 'custom';
  $('customLabel').replaceChildren(custom ? 'Your instructions' : 'Extra instructions ', custom ? '' : el('em', {}, '(optional)'));
  $('aiCustom').placeholder = custom ? 'Rewrite what I say as a short, friendly email.' : 'Use British spelling. Never use exclamation marks.';
  if (document.activeElement !== $('aiCustom')) $('aiCustom').value = settings.aiCustomPrompt;
  if (document.activeElement !== $('aiModel')) $('aiModel').value = settings.aiModel;
  renderPrice();
  setRadio('[data-output]', 'output', settings.outputMode);
  $('restoreClipboard').checked = settings.restoreClipboard;
  $('restoreClipboard').disabled = settings.outputMode !== 'paste';
  $('restoreHelp').textContent = settings.outputMode === 'paste' ? 'Puts back what you had copied after pasting.' : 'Not used in Copy only mode, since the text has to stay on the clipboard.';
  $('sounds').checked = settings.sounds;
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
$('aiCustom').addEventListener('change', (e) => save({ aiCustomPrompt: e.target.value }));
$('aiModel').addEventListener('change', (e) => {
  const v = e.target.value.trim();
  if (models.length && !models.some((m) => m.id === v)) { toast(`${v || 'That'} is not an OpenRouter model id.`, true); e.target.value = settings.aiModel; return; }
  save({ aiModel: v });
});
$('aiModel').addEventListener('input', renderPrice);

let modelsState = 'idle'; // idle | loading | ready | error
let modelsError = '';
function renderPrice() {
  $('aiModelRetry').hidden = modelsState !== 'error';
  if (modelsState === 'error') { $('aiPrice').textContent = `Could not load the model list: ${modelsError}`; return; }
  const m = models.find((x) => x.id === $('aiModel').value.trim());
  if (!m) { $('aiPrice').textContent = modelsState === 'loading' ? 'Loading models…' : 'Pick any OpenRouter chat model.'; return; }
  const per = (p) => (p * 1e6 < 1 ? `$${(p * 1e6).toFixed(2)}` : `$${(p * 1e6).toFixed(1)}`);
  $('aiPrice').textContent = `${m.name}. ${per(m.prompt)} in, ${per(m.completion)} out per million tokens.`;
}
async function loadModels(force = false) {
  if (modelsState === 'loading' || (modelsState === 'ready' && !force)) return renderPrice();
  modelsState = 'loading'; renderPrice();
  try {
    models = await api.invoke('models:list', force);
    $('aiModels').replaceChildren(...models.map((m) => el('option', { value: m.id }, m.name)));
    modelsState = 'ready';
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
      $('micMeter').style.width = `${Math.min(100, Math.sqrt(s / data.length) * 900)}%`;
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
  $('micTest').textContent = 'Start test';
}
$('micTest').addEventListener('click', () => (micTest ? stopMicTest() : startMicTest()));

// ---------- boot ----------
(async () => {
  try {
    const [s, st, info] = await Promise.all([api.invoke('settings:get'), api.invoke('status'), api.invoke('app:info')]);
    settings = s; status = st;
    $('ver').textContent = `Version ${info.version}`;
    if (!info.packaged) $('loginHelp').textContent = 'Available in the installed app.';
    $('launchAtLogin').disabled = !info.packaged;
    renderStatus();
    renderIssue();
    go('home');
  } catch (err) { toast(err.message, true); }
})();
