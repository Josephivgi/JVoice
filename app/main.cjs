'use strict';
const path = require('node:path');
const fs = require('node:fs');
const {
  app, BrowserWindow, Tray, Menu, ipcMain, clipboard, nativeImage, screen,
  safeStorage, shell, Notification, powerMonitor, session,
} = require('electron');
const { Store } = require('./db.cjs');
const api = require('./openrouter.cjs');
const { Hotkey, comboLabel, validateCombo, sortCombo } = require('./hotkey.cjs');

let win32 = null;
try { win32 = require('./win32.cjs'); } catch (err) { console.error('win32 helpers unavailable', err.message); }

const SMOKE = process.argv.includes('--smoke');
const START_HIDDEN = process.argv.includes('--hidden');
const TRANSCRIBE_ARG = process.argv.indexOf('--transcribe');
const SHOTS_ARG = process.argv.indexOf('--shots');
const RECORD_ARG = process.argv.indexOf('--record-test');
const HEADLESS = SMOKE || TRANSCRIBE_ARG > 0 || SHOTS_ARG > 0 || RECORD_ARG > 0 || process.argv.includes('--import-key');
const ICON = path.join(__dirname, '..', 'assets', 'icon.png');
const UI = path.join(__dirname, 'ui');

if (process.env.JVOICE_USER_DATA) app.setPath('userData', process.env.JVOICE_USER_DATA);
if (RECORD_ARG > 0) {
  // Feeds a WAV file to getUserMedia as a fake microphone, so the real recorder code runs without a mic.
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', `${path.resolve(process.argv[RECORD_ARG + 1])}%noloop`);
}
app.setAppUserModelId('com.josephivgi.jvoice');
if (!HEADLESS && !app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let store, mainWin, overlayWin, tray, failedDir;
const hotkey = new Hotkey();
let modelsCache = null;

// ---------- API key (encrypted with Windows DPAPI through safeStorage) ----------
function getKey() {
  const enc = store.getSettings().apiKeyEnc;
  if (!enc) return '';
  try { return safeStorage.decryptString(Buffer.from(enc, 'base64')); } catch { return ''; }
}
function setKey(key) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows could not encrypt the key on this account.');
  store.setSettings({ apiKeyEnc: key ? safeStorage.encryptString(key).toString('base64') : '' });
}
const maskKey = (k) => (k ? `${k.slice(0, 8)}…${k.slice(-4)}` : '');

function publicSettings() {
  const s = store.getSettings();
  const key = getKey();
  delete s.apiKeyEnc;
  return { ...s, hasKey: !!key, keyMasked: maskKey(key), hotkeyLabel: comboLabel(s.hotkey) };
}

// ---------- windows ----------
function send(win, channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
const toMain = (channel, payload) => send(mainWin, channel, payload);

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 980, height: 680, minWidth: 640, minHeight: 520,
    show: false, title: 'JVoice', icon: ICON, backgroundColor: '#15171c',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  mainWin.removeMenu();
  mainWin.loadFile(path.join(UI, 'index.html'));
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWin.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWin.on('close', (e) => {
    if (app.isQuitting) return;
    e.preventDefault();
    mainWin.hide();
    if (!store.getSettings().closeHintShown && Notification.isSupported()) {
      new Notification({ title: 'JVoice is still running', body: `Hold ${comboLabel(hotkey.combo).join(' + ')} anywhere to dictate. Quit from the tray icon.`, icon: ICON }).show();
      store.setSettings({ closeHintShown: true });
    }
  });
}

function showMain(page) {
  if (!mainWin || mainWin.isDestroyed()) createMainWindow();
  const go = () => { if (page) toMain('nav', page); };
  if (mainWin.webContents.isLoading()) mainWin.webContents.once('did-finish-load', go); else go();
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
}

const OVERLAY_W = 300, OVERLAY_H = 72;
let overlayReady = false;
let overlayQueue = [];
function createOverlay() {
  overlayReady = false;
  overlayQueue = [];
  overlayWin = new BrowserWindow({
    width: OVERLAY_W, height: OVERLAY_H, show: false, frame: false, transparent: true,
    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, focusable: false, alwaysOnTop: true, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
  });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setIgnoreMouseEvents(true);
  const w = overlayWin;
  w.webContents.once('did-finish-load', () => {
    if (w !== overlayWin) return;
    overlayReady = true;
    for (const [ch, payload] of overlayQueue.splice(0)) send(w, ch, payload);
  });
  w.loadFile(path.join(UI, 'overlay.html'));
}

// Messages sent before the overlay page loads (first start, or after a restart) are delivered once it is ready.
function toOverlay(channel, payload) {
  if (overlayReady) send(overlayWin, channel, payload);
  else overlayQueue.push([channel, payload]);
}

function recreateOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.destroy();
  createOverlay();
}

function showOverlay() {
  if (HEADLESS || !overlayWin || overlayWin.isDestroyed()) return;
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  overlayWin.setBounds({ x: Math.round(wa.x + (wa.width - OVERLAY_W) / 2), y: wa.y + wa.height - OVERLAY_H - 28, width: OVERLAY_W, height: OVERLAY_H });
  if (!overlayWin.isVisible()) overlayWin.showInactive();
}
let overlayHideTimer = null;
function overlayState(state, data = {}, hideAfterMs = 0) {
  clearTimeout(overlayHideTimer);
  toOverlay('overlay:state', { state, ...data });
  if (state !== 'hidden') showOverlay();
  if (hideAfterMs) overlayHideTimer = setTimeout(() => overlayState('hidden'), hideAfterMs);
  else if (state === 'hidden' && overlayWin && !overlayWin.isDestroyed()) overlayWin.hide();
}

// ---------- tray ----------
function trayIcon() { return nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }); }
function buildTrayMenu() {
  if (!tray) return;
  const label = comboLabel(hotkey.combo).join(' + ');
  tray.setToolTip(`JVoice: ${hotkey.paused ? 'shortcut paused' : `${hotkey.mode === 'hold' ? 'hold' : 'press'} ${label} to dictate`}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open JVoice', click: () => showMain() },
    { label: dictation.state === 'recording' ? 'Stop dictation' : 'Start dictation', click: () => dictation.toggle() },
    { type: 'separator' },
    { label: 'Pause shortcut', type: 'checkbox', checked: hotkey.paused, click: (i) => { hotkey.paused = i.checked; buildTrayMenu(); broadcastStatus(); } },
    { label: 'History', click: () => showMain('history') },
    { label: 'Settings', click: () => showMain('settings') },
    { type: 'separator' },
    { label: 'Quit JVoice', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}

// Last problem worth showing on Home (microphone blocked, key rejected, ...), until dismissed or fixed.
let lastIssue = null;
function reportIssue(message, action = '') {
  lastIssue = message ? { message, action, at: Date.now() } : null;
  broadcastStatus();
}
function statusPayload() {
  return { state: dictation.state, paused: hotkey.paused, hookOk: hotkey.started, issue: lastIssue };
}
function broadcastStatus() { toMain('status', statusPayload()); }
function issueAction(err) {
  if (err.status === 401 || err.status === 403) return 'key';
  if (err.status === 402) return 'credits';
  return '';
}

// ---------- WAV helper for the --transcribe test mode ----------
function readWav(file) { return fs.readFileSync(file); }

// ---------- dictation pipeline ----------
// Every recording gets a session id. Cancel bumps the id, so late replies from the recorder
// or the network for an old session are ignored instead of touching the new one.
const dictation = {
  state: 'idle', // idle | recording | processing
  session: 0,
  startedAt: 0,
  abort: null,
  pendingStop: null, // { id, resolve }
  watchdog: null, // { id, timer } until the recorder answers rec:stop
  target: null, // foreground window when recording started

  setState(s) {
    this.state = s;
    hotkey.recording = s !== 'idle';
    buildTrayMenu();
    broadcastStatus();
  },

  toggle() { if (this.state === 'recording') this.stop(); else if (this.state === 'idle') this.start(); },

  start() {
    if (this.state !== 'idle') return;
    const s = store.getSettings();
    if (!getKey()) {
      overlayState('error', { message: 'Add your OpenRouter key in JVoice first.' }, 2600);
      showMain('home');
      return;
    }
    const id = ++this.session;
    this.target = win32 ? win32.foregroundWindow() : null;
    this.setState('recording');
    this.startedAt = Date.now();
    showOverlay();
    toOverlay('rec:start', { id, deviceId: s.micDeviceId, sounds: s.sounds, maxSeconds: s.maxRecordSeconds });
  },

  interrupt() {
    // Extra key pressed while holding the combo: treat a fresh start as an accidental trigger.
    if (this.state === 'recording' && Date.now() - this.startedAt < 1500) this.cancel(true);
  },

  cancel(silent = false) {
    if (this.state === 'idle') return;
    const wasRecording = this.state === 'recording';
    this.session++;
    if (wasRecording || this.pendingStop) toOverlay('rec:cancel');
    if (this.abort) { this.abort.abort(); this.abort = null; }
    if (this.pendingStop) { this.pendingStop.resolve(null); this.pendingStop = null; }
    this.setState('idle');
    if (silent) overlayState('hidden'); else overlayState('cancelled', {}, 900);
  },

  stop() {
    if (this.state !== 'recording') return;
    const id = this.session;
    this.setState('processing');
    overlayState('transcribing');
    const p = new Promise((resolve) => { this.pendingStop = { id, resolve }; });
    toOverlay('rec:stop', { id });
    // Watchdog: if the recorder never answers for this session (even after a cancel), restart it,
    // so a hung audio thread cannot keep the microphone open.
    clearTimeout(this.watchdog?.timer);
    this.watchdog = { id, timer: setTimeout(() => {
      this.watchdog = null;
      if (this.pendingStop?.id === id) this.pendingStop.resolve({ id, error: 'The recorder stopped responding, so JVoice restarted it. Try again.' });
      const orphan = this.state === 'recording' && this.session !== id;
      recreateOverlay();
      if (orphan) {
        if (this.pendingStop) { this.pendingStop.resolve(null); this.pendingStop = null; }
        this.session++;
        this.setState('idle');
        overlayState('error', { message: 'The recorder stopped responding, so JVoice restarted it. Try again.' }, 3600);
      }
    }, 5000) };
    p.then((rec) => {
      if (this.pendingStop?.id === id) this.pendingStop = null;
      if (rec && id === this.session) this.process(id, rec);
    });
  },

  onRecorded(rec) {
    if (this.watchdog && rec?.id === this.watchdog.id) { clearTimeout(this.watchdog.timer); this.watchdog = null; }
    if (this.pendingStop && rec?.id === this.pendingStop.id) this.pendingStop.resolve(rec);
  },

  onRecorderError({ id, message }) {
    if (id !== this.session || this.state === 'idle') return;
    if (this.pendingStop) { this.pendingStop.resolve(null); this.pendingStop = null; }
    this.session++;
    this.setState('idle');
    overlayState('error', { message }, 3600);
    reportIssue(message, 'mic');
  },

  async process(id, rec) {
    const current = () => id === this.session;
    const fail = (message, ms) => { if (current()) overlayState('error', { message }, ms); };
    const ac = new AbortController();
    this.abort = ac;
    try {
      if (rec.error) return fail(rec.error, 3600);
      if (rec.ms < 350) return fail('Too short. Hold the keys while you talk.', 1800);
      if (rec.peak < 0.01) {
        reportIssue('JVoice heard only silence from your microphone. Check the input device in Settings.', 'mic');
        return fail('No sound from the microphone. Check Settings.', 3000);
      }
      const result = await runPipeline({ wav: Buffer.from(rec.wav), ms: rec.ms, signal: ac.signal, onStage: (st) => { if (current()) overlayState(st); } });
      if (ac.signal.aborted || !current()) return;
      if (!result.final) return fail('No speech detected.', 1800);
      const out = await output(result.final, { signal: ac.signal, target: this.target });
      if (ac.signal.aborted || !current()) return;
      if (lastIssue && lastIssue.action !== 'history') reportIssue(null);
      const note = out.note || (result.aiError ? 'AI cleanup failed, so the raw text was used.' : '');
      overlayState('done', { words: result.words, pasted: out.pasted, note }, note ? 3000 : 1300);
    } catch (err) {
      if (ac.signal.aborted || !current()) return;
      fail(err.message, 3600);
      reportIssue(err.saved ? `${err.message} The recording is saved in History.` : err.message, issueAction(err) || (err.saved ? 'history' : ''));
    } finally {
      if (this.abort === ac) this.abort = null;
      if (current() && this.state === 'processing') this.setState('idle');
    }
  },
};

// Transcribe, clean up, store in history. Failed audio is kept so the user can retry.
async function runPipeline({ wav, ms, signal, onStage = () => {}, historyId = null }) {
  const s = store.getSettings();
  const key = getKey();
  const dict = store.listDictionary();
  const terms = dict.map((d) => d.term);
  const base = { style: s.aiEnabled ? s.aiStyle : 'raw', stt_model: s.sttModel, duration_ms: ms };
  let raw;
  let cost = 0;
  try {
    const t = await api.transcribe({ key, model: s.sttModel, wav, language: s.language, signal });
    raw = api.applyDictionary(t.text, dict);
    cost += t.cost;
  } catch (err) {
    if (signal?.aborted) throw err;
    if (s.keepHistory) {
      let row = historyId ? store.getHistoryItem(historyId) : null;
      if (!row) {
        row = store.addHistory({ ...base, status: 'failed', error: err.message });
        const file = path.join(failedDir, `${row.id}.wav`);
        fs.writeFileSync(file, wav);
        store.updateHistory(row.id, { audio_path: file });
      } else store.updateHistory(row.id, { error: err.message });
      toMain('history:changed');
      err.saved = true; // the recording is in History with Retry
    }
    throw err;
  }

  let final = raw;
  let aiError = '';
  if (raw && s.aiEnabled) {
    onStage('improving');
    try {
      const r = await api.improve({ key, model: s.aiModel, text: raw, style: s.aiStyle, customPrompt: s.aiCustomPrompt, terms, signal });
      cost += r.cost;
      final = api.applyDictionary(r.text, dict) || raw;
    } catch (err) {
      if (signal?.aborted) throw err;
      aiError = err.message;
    }
  }

  const words = api.countWords(final);
  if (s.keepHistory && final) {
    const fields = { status: 'done', raw, final, error: aiError ? `AI cleanup failed: ${aiError}` : '', ai_model: s.aiEnabled && !aiError ? s.aiModel : '', words, cost };
    if (historyId) {
      const old = store.getHistoryItem(historyId);
      if (old?.audio_path) fs.rm(old.audio_path, { force: true }, () => {});
      store.updateHistory(historyId, { ...fields, audio_path: '' });
    } else store.addHistory({ ...base, ...fields });
    toMain('history:changed');
  }
  return { raw, final, words, cost, aiError };
}

// Puts the text into the app the user was in. Falls back to copy-only whenever pasting could go wrong.
async function output(text, { signal, target } = {}) {
  const s = store.getSettings();
  if (s.outputMode !== 'paste') { clipboard.writeText(text); return { pasted: false }; }
  const released = await hotkey.waitForModifiersReleased(1500, signal);
  if (signal?.aborted) return { pasted: false };
  if (!released) { clipboard.writeText(text); return { pasted: false, note: 'Keys were still held, so the text was copied instead.' }; }
  const sameWindow = () => {
    if (!win32) return true; // helper failed to load (smoke test reports this); paste without the check
    const now = win32.foregroundWindow();
    return !!target && !!now && now.id === target.id && now.pid === target.pid;
  };
  const switched = { pasted: false, note: 'You switched windows, so the text was copied instead.' };
  if (!sameWindow()) { clipboard.writeText(text); return switched; }
  let snap = null;
  if (s.restoreClipboard && win32) {
    try { snap = await win32.snapshotClipboard(); } catch { snap = null; }
  }
  // The snapshot can wait on another app's clipboard lock, so check everything again right before pasting.
  if (signal?.aborted) return { pasted: false };
  clipboard.writeText(text);
  if (!sameWindow()) return switched;
  if (hotkey.modifiersDown()) return { pasted: false, note: 'Keys were still held, so the text was copied instead.' };
  const seq = win32 ? win32.clipboardSequence() : 0;
  hotkey.paste();
  if (snap) {
    setTimeout(async () => {
      // Only put the old clipboard back if nothing else was copied in the meantime (checked under the clipboard lock).
      try { await win32.restoreClipboard(snap, clipboardOwner(), seq); } catch (err) { console.error('clipboard restore failed', err.message); }
    }, 700);
  }
  return { pasted: true };
}

function clipboardOwner() {
  const w = overlayWin && !overlayWin.isDestroyed() ? overlayWin : mainWin;
  return win32.hwndOf(w.getNativeWindowHandle());
}

// ---------- IPC ----------
function applyHotkeySettings() {
  const s = store.getSettings();
  hotkey.configure({ combo: s.hotkey, mode: s.hotkeyMode });
  buildTrayMenu();
}

function applyLoginItem(on) {
  if (!app.isPackaged) return; // a dev build would register electron.exe
  app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] });
}

function registerIpc() {
  const handle = (ch, fn) => ipcMain.handle(ch, async (_e, ...args) => {
    try { return { ok: true, data: await fn(...args) }; } catch (err) { return { ok: false, error: err.message || String(err) }; }
  });

  handle('settings:get', () => publicSettings());
  handle('settings:set', (patch) => {
    const clean = { ...patch };
    delete clean.apiKeyEnc;
    if (clean.hotkey) {
      const msg = validateCombo(clean.hotkey);
      if (msg) throw new Error(msg);
      clean.hotkey = sortCombo(clean.hotkey);
    }
    if (clean.hotkeyMode && !['hold', 'toggle'].includes(clean.hotkeyMode)) delete clean.hotkeyMode;
    if (clean.aiStyle && !['clean', 'intent', 'custom'].includes(clean.aiStyle)) delete clean.aiStyle;
    if (clean.outputMode && !['paste', 'copy'].includes(clean.outputMode)) delete clean.outputMode;
    if ('sttModel' in clean) clean.sttModel = String(clean.sttModel).trim() || 'elevenlabs/scribe-v2';
    if ('aiModel' in clean) clean.aiModel = String(clean.aiModel).trim() || 'anthropic/claude-haiku-5.5';
    if ('language' in clean) clean.language = String(clean.language).trim().toLowerCase().slice(0, 8);
    store.setSettings(clean);
    if ('launchAtLogin' in clean) applyLoginItem(!!clean.launchAtLogin);
    if (clean.hotkey || clean.hotkeyMode) applyHotkeySettings();
    return publicSettings();
  });
  handle('key:set', async (key) => {
    key = String(key ?? '').trim();
    if (!key) throw new Error('Paste your OpenRouter key.');
    if (!/^sk-or-/.test(key)) throw new Error('That does not look like an OpenRouter key. Keys start with sk-or-.');
    const info = await api.keyInfo(key);
    setKey(key);
    if (lastIssue && ['key', 'credits'].includes(lastIssue.action)) reportIssue(null);
    return { settings: publicSettings(), info };
  });
  handle('key:clear', () => { setKey(''); return publicSettings(); });
  handle('key:info', async () => { const k = getKey(); return k ? api.keyInfo(k) : null; });
  handle('models:list', async (force) => {
    if (!modelsCache || force) modelsCache = await api.listChatModels();
    return modelsCache;
  });

  handle('history:list', (query) => store.listHistory({ query: String(query ?? '').trim() }));
  handle('history:delete', (id) => {
    const row = store.deleteHistory(id);
    if (row?.audio_path) fs.rm(row.audio_path, { force: true }, () => {});
    return true;
  });
  handle('history:clear', () => {
    for (const f of store.clearHistory()) fs.rm(f, { force: true }, () => {});
    return true;
  });
  handle('history:retry', async (id) => {
    const row = store.getHistoryItem(id);
    if (!row?.audio_path || !fs.existsSync(row.audio_path)) throw new Error('The recording for this entry is gone.');
    const wav = fs.readFileSync(row.audio_path);
    const r = await runPipeline({ wav, ms: row.duration_ms, historyId: id });
    if (r.final) clipboard.writeText(r.final);
    return r;
  });
  handle('clipboard:write', (text) => { clipboard.writeText(String(text ?? '')); return true; });
  handle('stats', () => store.stats());

  handle('dict:list', () => store.listDictionary());
  handle('dict:save', (entry) => {
    try { return store.saveDictionary(entry); } catch (err) {
      if (/UNIQUE/.test(err.message)) throw new Error('That word is already in your dictionary.');
      throw err;
    }
  });
  handle('dict:delete', (id) => store.deleteDictionary(id));

  handle('hotkey:capture', (on) => {
    if (!on) { hotkey.capture = null; return true; }
    if (!hotkey.started) throw new Error('The keyboard hook is not running.');
    let peak = [];
    hotkey.capture = (type, code, held) => {
      if (type === 'down') {
        if (held.length >= peak.length) peak = held;
        toMain('hotkey:capture', { held: comboLabel(held), done: false });
      } else if (held.length === 0 && peak.length) {
        const combo = sortCombo(peak);
        hotkey.capture = null;
        toMain('hotkey:capture', { held: comboLabel(combo), combo, error: validateCombo(combo), done: true });
      }
    };
    return true;
  });

  handle('dictation:toggle', () => { dictation.toggle(); return dictation.state; });
  handle('status', () => statusPayload());
  handle('issue:dismiss', () => { reportIssue(null); return true; });
  handle('app:info', () => ({ version: app.getVersion(), packaged: app.isPackaged }));
  handle('open:external', (url) => {
    if (!/^https:\/\/(openrouter\.ai|github\.com)\//.test(url)) throw new Error('Blocked link.');
    return shell.openExternal(url);
  });
  handle('open:mic-settings', () => shell.openExternal('ms-settings:privacy-microphone'));

  // Overlay recorder events (fire and forget).
  ipcMain.on('rec:done', (_e, rec) => dictation.onRecorded(rec));
  ipcMain.on('rec:error', (_e, err) => dictation.onRecorderError({ id: err?.id, message: String(err?.message ?? 'The microphone failed.') }));
  ipcMain.on('rec:limit', (_e, id) => { if (id === dictation.session) dictation.stop(); });
}

// ---------- test modes ----------
async function runSmoke() {
  const report = { db: false, hook: false, encryption: safeStorage.isEncryptionAvailable(), pages: {} };
  report.db = !!store.getSettings();
  registerIpc();
  try { report.win32 = !!win32?.foregroundWindow() && typeof win32.clipboardSequence() === 'number'; } catch (err) { report.win32 = false; report.win32Error = err.message; }
  try { hotkey.start(); report.hook = hotkey.started; hotkey.stop(); } catch (err) { report.hookError = err.message; }
  for (const page of ['index.html', 'overlay.html']) {
    const w = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true } });
    const errors = [];
    w.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message); });
    await w.loadFile(path.join(UI, page));
    await new Promise((r) => setTimeout(r, 1500));
    const ui = await w.webContents.executeJavaScript(`({
      page: [...document.querySelectorAll('.page')].find((p) => !p.hidden)?.id || null,
      toast: document.getElementById('toast')?.className.includes('show') ? document.getElementById('toast').textContent : '',
      hero: document.getElementById('heroTitle')?.textContent || null,
    })`);
    if (ui.toast) errors.push(`toast: ${ui.toast}`);
    report.pages[page] = { title: w.getTitle(), ui, errors };
    w.destroy();
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  app.exit(report.db && report.hook && report.win32 && Object.values(report.pages).every((p) => !p.errors.length) ? 0 : 1);
}

// Renders every page offscreen to PNGs for UI review. Nothing is shown on screen.
async function runShots(dir) {
  const { nativeTheme } = require('electron');
  fs.mkdirSync(dir, { recursive: true });
  registerIpc();
  const shot = async (w, name) => {
    await new Promise((r) => setTimeout(r, 450));
    fs.writeFileSync(path.join(dir, `${name}.png`), (await w.webContents.capturePage()).toPNG());
  };
  for (const theme of ['dark', 'light']) {
    nativeTheme.themeSource = theme;
    for (const [w, h] of [[980, 680], [760, 540]]) {
      const win = new BrowserWindow({ show: false, width: w, height: h, useContentSize: true, webPreferences: { offscreen: true, preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true } });
      await win.loadFile(path.join(UI, 'index.html'));
      for (const page of ['home', 'history', 'dictionary', 'settings']) {
        win.webContents.send('nav', page);
        await shot(win, `${theme}-${w}-${page}`);
        if (page === 'settings') {
          for (const y of [700, 1400]) {
            await win.webContents.executeJavaScript(`document.getElementById('main').scrollTop = ${y}`);
            await shot(win, `${theme}-${w}-${page}-scroll${y}`);
          }
        }
      }
      win.destroy();
    }
    const ov = new BrowserWindow({ show: false, width: OVERLAY_W, height: OVERLAY_H, transparent: true, frame: false, webPreferences: { offscreen: true, preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true } });
    await ov.loadFile(path.join(UI, 'overlay.html'));
    const states = [
      ['recording', `document.getElementById('pill').dataset.state='recording';document.querySelectorAll('.wave i').forEach((b,i)=>b.style.transform='scaleY('+(0.2+0.8*Math.abs(Math.sin(i/2)))+')');document.getElementById('time').textContent='0:07'`],
      ['transcribing', `render('transcribing')`], ['improving', `render('improving')`],
      ['done', `render('done',{words:42,pasted:true})`], ['copied', `render('done',{words:1,pasted:false})`],
      ['error', `render('error',{message:'Your OpenRouter account is out of credits.'})`],
      ['error-long', `render('error',{message:'Microphone access is blocked. Allow it in Windows privacy settings.'})`],
    ];
    for (const [name, js] of states) { await ov.webContents.executeJavaScript(js); await shot(ov, `${theme}-overlay-${name}`); }
    ov.destroy();
  }
  process.stdout.write(`shots written to ${dir}\n`);
  app.exit(0);
}

// --record-test <input.wav> <ms> <output.wav>: records through the hidden overlay recorder and saves the WAV.
async function runRecordTest(ms, outFile) {
  createOverlay();
  await new Promise((res) => overlayWin.webContents.once('did-finish-load', res));
  await new Promise((res) => setTimeout(res, 1500)); // the real app loads the overlay long before the first dictation
  const done = new Promise((res) => ipcMain.once('rec:done', (_e, rec) => res(rec)));
  const err = new Promise((res) => ipcMain.once('rec:error', (_e, e) => res({ error: e.message })));
  send(overlayWin, 'rec:start', { id: 1, deviceId: '', sounds: false, maxSeconds: 60 });
  await new Promise((res) => setTimeout(res, ms));
  send(overlayWin, 'rec:stop', { id: 1 });
  const rec = await Promise.race([done, err, new Promise((res) => setTimeout(() => res({ error: 'timeout' }), 5000))]);
  if (rec.error) { process.stderr.write(`ERROR: ${rec.error}\n`); return app.exit(1); }
  const wav = Buffer.from(rec.wav);
  fs.writeFileSync(outFile, wav);
  const rate = wav.readUInt32LE(24), channels = wav.readUInt16LE(22), bits = wav.readUInt16LE(34);
  process.stdout.write(JSON.stringify({ lagMs: rec.lagMs, startupMs: rec.requestedAt ? Date.now() - rec.requestedAt - rec.ms : null, ctxRate: rec.rate, id: rec.id, ms: rec.ms, peak: Number(rec.peak.toFixed(3)), bytes: wav.length, rate, channels, bits, audioSeconds: (wav.length - 44) / (rate * 2) }) + '\n');
  app.exit(0);
}

async function runTranscribeFile(file) {
  try {
    if (!getKey()) throw new Error('No OpenRouter key saved. Add one in the app first.');
    const wav = readWav(file);
    const ms = Math.round(((wav.length - 44) / 32000) * 1000);
    const r = await runPipeline({ wav, ms });
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    app.exit(0);
  } catch (err) {
    process.stderr.write(`ERROR: ${err.message}\n`);
    app.exit(1);
  }
}

// ---------- lifecycle ----------
app.on('second-instance', () => showMain());
app.on('window-all-closed', (e) => e.preventDefault());

app.whenReady().then(async () => {
  store = new Store(path.join(app.getPath('userData'), 'jvoice.db'));
  failedDir = path.join(app.getPath('userData'), 'failed-audio');
  fs.mkdirSync(failedDir, { recursive: true });

  // Only our own pages ask for anything, and only the microphone.
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(perm === 'media'));
  session.defaultSession.setPermissionCheckHandler((wc, perm) => perm === 'media');

  if (SMOKE) return runSmoke();
  if (TRANSCRIBE_ARG > 0) return runTranscribeFile(process.argv[TRANSCRIBE_ARG + 1]);
  if (process.argv.includes('--import-key')) {
    // Headless key import for setup scripts: reads JVOICE_IMPORT_KEY, checks it with OpenRouter, stores it encrypted.
    try {
      const key = String(process.env.JVOICE_IMPORT_KEY || '').trim();
      const info = await api.keyInfo(key);
      setKey(key);
      process.stdout.write(`key saved (${maskKey(key)}, usage $${info.usage.toFixed(4)})\n`);
      return app.exit(0);
    } catch (err) { process.stderr.write(`ERROR: ${err.message}\n`); return app.exit(1); }
  }
  if (RECORD_ARG > 0) return runRecordTest(Number(process.argv[RECORD_ARG + 2]) || 4000, path.resolve(process.argv[RECORD_ARG + 3] || 'record-test.wav'));
  if (SHOTS_ARG > 0) return runShots(path.resolve(process.argv[SHOTS_ARG + 1] || 'shots'));

  registerIpc();
  applyHotkeySettings();
  hotkey.on('start', () => dictation.start());
  hotkey.on('stop', () => dictation.stop());
  hotkey.on('cancel', () => dictation.cancel());
  hotkey.on('interrupt', () => dictation.interrupt());
  try { hotkey.start(); } catch (err) { console.error('keyboard hook failed', err); }
  powerMonitor.on('lock-screen', () => { hotkey.reset(); if (dictation.state === 'recording') dictation.cancel(true); });
  powerMonitor.on('resume', () => hotkey.reset());

  createOverlay();
  createMainWindow();
  tray = new Tray(trayIcon());
  tray.on('click', () => showMain());
  buildTrayMenu();

  const s = store.getSettings();
  if (!START_HIDDEN || !getKey()) mainWin.once('ready-to-show', () => showMain(getKey() ? null : 'home'));
  if (s.launchAtLogin) applyLoginItem(true);
});

app.on('before-quit', () => {
  app.isQuitting = true;
  try { hotkey.stop(); } catch { /* already stopped */ }
});
