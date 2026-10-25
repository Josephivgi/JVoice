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

const SMOKE = process.argv.includes('--smoke');
const START_HIDDEN = process.argv.includes('--hidden');
const TRANSCRIBE_ARG = process.argv.indexOf('--transcribe');
const SHOTS_ARG = process.argv.indexOf('--shots');
const HEADLESS = SMOKE || TRANSCRIBE_ARG > 0 || SHOTS_ARG > 0;
const ICON = path.join(__dirname, '..', 'assets', 'icon.png');
const UI = path.join(__dirname, 'ui');

if (process.env.JVOICE_USER_DATA) app.setPath('userData', process.env.JVOICE_USER_DATA);
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
    width: 980, height: 680, minWidth: 760, minHeight: 540,
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
function createOverlay() {
  overlayWin = new BrowserWindow({
    width: OVERLAY_W, height: OVERLAY_H, show: false, frame: false, transparent: true,
    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, focusable: false, alwaysOnTop: true, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
  });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setIgnoreMouseEvents(true);
  overlayWin.loadFile(path.join(UI, 'overlay.html'));
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
  send(overlayWin, 'overlay:state', { state, ...data });
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

function broadcastStatus() {
  toMain('status', { state: dictation.state, paused: hotkey.paused, hookOk: hotkey.started });
}

// ---------- WAV helper for the --transcribe test mode ----------
function readWav(file) { return fs.readFileSync(file); }

// ---------- dictation pipeline ----------
const dictation = {
  state: 'idle', // idle | recording | processing
  startedAt: 0,
  abort: null,
  pendingStop: null,

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
      showMain('settings');
      return;
    }
    this.setState('recording');
    this.startedAt = Date.now();
    showOverlay();
    send(overlayWin, 'rec:start', { deviceId: s.micDeviceId, sounds: s.sounds, maxSeconds: s.maxRecordSeconds, mode: hotkey.mode, combo: comboLabel(hotkey.combo) });
  },

  interrupt() {
    // Extra key pressed while holding the combo: treat a fresh start as an accidental trigger.
    if (this.state === 'recording' && Date.now() - this.startedAt < 1500) this.cancel(true);
  },

  cancel(silent = false) {
    if (this.state === 'recording') send(overlayWin, 'rec:cancel');
    if (this.abort) this.abort.abort();
    if (this.pendingStop) { this.pendingStop.resolve(null); this.pendingStop = null; }
    this.setState('idle');
    if (silent) overlayState('hidden'); else overlayState('cancelled', {}, 900);
  },

  stop() {
    if (this.state !== 'recording') return;
    this.setState('processing');
    overlayState('transcribing');
    const p = new Promise((resolve) => { this.pendingStop = { resolve }; });
    send(overlayWin, 'rec:stop');
    const timer = setTimeout(() => this.pendingStop?.resolve({ error: 'The recorder did not respond.' }), 5000);
    p.then((rec) => { clearTimeout(timer); this.pendingStop = null; if (rec) this.process(rec); });
  },

  onRecorded(rec) { this.pendingStop?.resolve(rec); },

  onRecorderError(message) {
    if (this.state === 'idle') return;
    this.pendingStop?.resolve(null);
    this.setState('idle');
    overlayState('error', { message }, 3200);
  },

  async process(rec) {
    if (rec.error) { this.setState('idle'); overlayState('error', { message: rec.error }, 3000); return; }
    const wav = Buffer.from(rec.wav);
    if (rec.ms < 350) { this.setState('idle'); overlayState('error', { message: 'Too short. Hold the keys while you talk.' }, 1800); return; }
    if (rec.peak < 0.01) { this.setState('idle'); overlayState('error', { message: 'No sound from the microphone. Check Settings.' }, 3000); return; }
    this.abort = new AbortController();
    const signal = this.abort.signal;
    try {
      const result = await runPipeline({ wav, ms: rec.ms, signal, onStage: (st) => overlayState(st) });
      if (signal.aborted) return;
      if (!result.final) { overlayState('error', { message: 'No speech detected.' }, 1800); return; }
      const pasted = await output(result.final);
      overlayState('done', { words: result.words, pasted, note: result.aiError ? 'AI cleanup failed, used the raw text.' : '' }, result.aiError ? 2600 : 1300);
    } catch (err) {
      if (signal.aborted) return;
      overlayState('error', { message: err.message }, 3600);
    } finally {
      this.abort = null;
      if (this.state === 'processing') this.setState('idle');
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

async function output(text) {
  const s = store.getSettings();
  const saved = s.restoreClipboard ? snapshotClipboard() : null;
  clipboard.writeText(text);
  if (s.outputMode !== 'paste') return false;
  await hotkey.waitForModifiersReleased();
  hotkey.paste();
  if (saved) {
    setTimeout(() => { if (clipboard.readText() === text) restoreClipboard(saved); }, 700);
  }
  return true;
}

function snapshotClipboard() {
  const img = clipboard.readImage();
  return { text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(), image: img.isEmpty() ? null : img };
}
function restoreClipboard(c) {
  const data = {};
  if (c.text) data.text = c.text;
  if (c.html) data.html = c.html;
  if (c.rtf) data.rtf = c.rtf;
  if (c.image) data.image = c.image;
  if (Object.keys(data).length) clipboard.write(data); else clipboard.clear();
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
  handle('status', () => ({ state: dictation.state, paused: hotkey.paused, hookOk: hotkey.started }));
  handle('app:info', () => ({ version: app.getVersion(), packaged: app.isPackaged }));
  handle('open:external', (url) => {
    if (!/^https:\/\/(openrouter\.ai|github\.com)\//.test(url)) throw new Error('Blocked link.');
    return shell.openExternal(url);
  });
  handle('open:mic-settings', () => shell.openExternal('ms-settings:privacy-microphone'));

  // Overlay recorder events (fire and forget).
  ipcMain.on('rec:done', (_e, rec) => dictation.onRecorded(rec));
  ipcMain.on('rec:error', (_e, message) => dictation.onRecorderError(String(message)));
  ipcMain.on('rec:limit', () => dictation.stop());
}

// ---------- test modes ----------
async function runSmoke() {
  const report = { db: false, hook: false, encryption: safeStorage.isEncryptionAvailable(), pages: {} };
  report.db = !!store.getSettings();
  registerIpc();
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
  app.exit(report.db && report.hook && Object.values(report.pages).every((p) => !p.errors.length) ? 0 : 1);
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
