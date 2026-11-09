'use strict';
const path = require('node:path');
const fs = require('node:fs');
const {
  app, BrowserWindow, Tray, Menu, ipcMain, clipboard, nativeImage, screen,
  safeStorage, shell, Notification, powerMonitor, session, net, protocol, desktopCapturer, dialog,
} = require('electron');
const { execFile } = require('node:child_process');
const { Store, DEFAULTS } = require('./db.cjs');
const api = require('./openrouter.cjs');
const speed = require('./speed.cjs');
const { Hotkey, comboLabel, validateCombo, sortCombo } = require('./hotkey.cjs');
const { Updater } = require('./updater.cjs');
const agent = require('./agent.cjs');

let win32 = null;
try { win32 = require('./win32.cjs'); } catch (err) { console.error('win32 helpers unavailable', err.message); }

// Test modes read files, use the saved key or record the mic with no UI, so the installed app ignores
// them. Only --smoke (a self check that prints yes/no results) works in every build.
const DEV = !app.isPackaged;
// Agent mode is offered in every build now; speech to text stays the default mode.
const BETA = true;
const devArg = (name) => (DEV ? process.argv.indexOf(name) : -1);
const SMOKE = process.argv.includes('--smoke');
const START_HIDDEN = process.argv.includes('--hidden');
const TRANSCRIBE_ARG = devArg('--transcribe');
const SHOTS_ARG = devArg('--shots');
const RECORD_ARG = devArg('--record-test');
const SPEED_ARG = devArg('--speed-test');
const AGENT_ARG = devArg('--agent');
const IMPORT_KEY = devArg('--import-key') > 0;
const HEADLESS = SMOKE || TRANSCRIBE_ARG > 0 || SHOTS_ARG > 0 || RECORD_ARG > 0 || SPEED_ARG > 0 || AGENT_ARG > 0 || IMPORT_KEY;
const ICON = path.join(__dirname, '..', 'assets', 'icon.png');
const UI = path.join(__dirname, 'ui');
const ASSETS = path.join(__dirname, '..', 'assets');
// Pages are served from app://jvoice/ (not file://), so file:// can stay locked down by the fuses.
const UI_URL = 'app://jvoice/';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
function serveUi() {
  protocol.handle('app', async (req) => {
    const u = new URL(req.url);
    // /assets/ is the app icon folder; everything else is a page file. Paths must stay inside their folder.
    const assets = u.pathname.startsWith('/assets/');
    const base = assets ? ASSETS : UI;
    const file = path.normalize(path.join(base, decodeURIComponent(assets ? u.pathname.slice('/assets'.length) : u.pathname)));
    if (u.host !== 'jvoice' || !file.startsWith(base + path.sep)) return new Response('Not found', { status: 404 });
    try {
      return new Response(await fs.promises.readFile(file), { headers: { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' } });
    } catch { return new Response('Not found', { status: 404 }); }
  });
}
const loadPage = (win, page) => win.loadURL(UI_URL + page);

if (DEV && process.env.JVOICE_USER_DATA) app.setPath('userData', process.env.JVOICE_USER_DATA);
if (RECORD_ARG > 0 || SPEED_ARG > 0) {
  // Feeds a WAV file to getUserMedia as a fake microphone, so the real recorder code runs without a mic.
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', `${path.resolve(process.argv[(RECORD_ARG > 0 ? RECORD_ARG : SPEED_ARG) + 1])}%noloop`);
}
app.setAppUserModelId('com.josephivgi.jvoice');
if (!HEADLESS && !app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let store, mainWin, overlayWin, tray, failedDir, updater;
const hotkey = new Hotkey({ send: win32 ? win32.sendKeys : null });
let modelsCache = null;

// ---------- API key (encrypted with Windows DPAPI through safeStorage) ----------
// Decrypted once and kept in memory, since each dictation needs it several times.
let keyCache = null;
function getKey() {
  if (keyCache !== null) return keyCache;
  const enc = store.getSettings().apiKeyEnc;
  if (!enc) return (keyCache = '');
  try { keyCache = safeStorage.decryptString(Buffer.from(enc, 'base64')); } catch { keyCache = ''; }
  return keyCache;
}
function setKey(key) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows could not encrypt the key on this account.');
  store.setSettings({ apiKeyEnc: key ? safeStorage.encryptString(key).toString('base64') : '' });
  keyCache = key || '';
}
const maskKey = (k) => (k ? `${k.slice(0, 8)}…${k.slice(-4)}` : '');

function publicSettings() {
  const s = store.getSettings();
  const key = getKey();
  delete s.apiKeyEnc;
  return { ...s, mode: agentMode(s) ? 'agent' : 'voice', beta: BETA, hasKey: !!key, keyMasked: maskKey(key), hotkeyLabel: comboLabel(s.hotkey) };
}

// ---------- windows ----------
function send(win, channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
const toMain = (channel, payload) => send(mainWin, channel, payload);

const webPrefs = (extra = {}) => ({ preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, devTools: DEV, ...extra });
const SAFE_LINK = /^https:\/\/(openrouter\.ai|github\.com)\//;
// Our pages never navigate or open windows; links to the two sites JVoice uses open in the browser.
function lockDown(wc) {
  wc.setWindowOpenHandler(({ url }) => {
    if (SAFE_LINK.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.on('will-redirect', (e) => e.preventDefault());
}

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 980, height: 680, minWidth: 640, minHeight: 520,
    show: false, title: 'JVoice', icon: ICON, backgroundColor: '#15171c',
    autoHideMenuBar: true,
    webPreferences: webPrefs(),
  });
  mainWin.removeMenu();
  loadPage(mainWin, 'index.html');
  lockDown(mainWin.webContents);
  // A reloaded or crashed page has lost its speed test, so the shortcut and updates must not stay blocked.
  mainWin.webContents.on('did-start-loading', () => speedTest.setActive(false));
  mainWin.webContents.on('render-process-gone', () => speedTest.setActive(false));
  mainWin.on('close', (e) => {
    if (app.isQuitting) return;
    e.preventDefault();
    mainWin.hide();
    if (!store.getSettings().closeHintShown && Notification.isSupported()) {
      new Notification({ title: 'JVoice is still running', body: `Hold ${comboLabel(hotkey.combo).join(' + ')} anywhere to dictate, or tap it to talk hands-free. Quit from the tray icon.`, icon: ICON }).show();
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

// Tall enough for the assistant card; the status pill sits at the bottom and the rest is see-through.
const OVERLAY_W = 440, OVERLAY_H = 250;
let overlayReady = false;
let overlayQueue = [];
function createOverlay() {
  overlayReady = false;
  overlayQueue = [];
  overlayWin = new BrowserWindow({
    width: OVERLAY_W, height: OVERLAY_H, show: false, frame: false, transparent: true,
    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, focusable: false, alwaysOnTop: true, hasShadow: false,
    webPreferences: webPrefs({ backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' }),
  });
  lockDown(overlayWin.webContents);
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setIgnoreMouseEvents(true);
  const w = overlayWin;
  w.webContents.once('did-finish-load', () => {
    if (w !== overlayWin) return;
    overlayReady = true;
    for (const [ch, payload] of overlayQueue.splice(0)) send(w, ch, payload);
  });
  loadPage(w, 'overlay.html');
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
    ...(BETA ? [
      { label: 'Speech to text mode', type: 'radio', checked: !agentMode(), click: () => setMode('voice') },
      { label: 'Agent mode', type: 'radio', checked: agentMode(), click: () => setMode('agent') },
    ] : []),
    { label: 'History', click: () => showMain('history') },
    { label: updater?.state.status === 'ready' ? `Restart to update to ${updater.state.next}` : 'Check for updates',
      click: () => (updater?.state.status === 'ready' ? updater.restartNow() : (updater?.check(), showMain('settings'))) },
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
  return { state: dictation.state, paused: hotkey.paused, hookOk: hotkey.started, issue: lastIssue, speedTest: speedTest.active };
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
const TAP_MS = 600; // a hold shorter than this (from the moment the mic is live) counts as a tap
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
    if (s === 'idle') this.clip = null; // a clipboard copy can be large; never keep it between dictations
    hotkey.recording = s !== 'idle';
    buildTrayMenu();
    broadcastStatus();
  },

  toggle() { if (this.state === 'recording') this.stop(); else if (this.state === 'idle') this.start(); },

  // Hold mode, combo pressed. While a hands-free recording runs, the next press ends it.
  press() {
    if (this.state === 'recording' && this.handsFree) this.stop();
    else this.start();
  },

  // Hold mode, combo released. A quick tap, or letting go before the microphone was ready,
  // keeps recording hands-free instead of failing with "too short"; the next press stops it.
  release() {
    if (this.state !== 'recording' || this.handsFree) return;
    if (!this.liveAt || Date.now() - this.liveAt < TAP_MS) {
      this.handsFree = true;
      toOverlay('rec:handsfree', { label: `${comboLabel(hotkey.combo).join(' + ')} to stop` });
      return;
    }
    this.stop();
  },

  onLive(id) { if (id === this.session && this.state === 'recording') this.liveAt = Date.now(); },

  start() {
    if (this.state !== 'idle') return;
    if (speedTest.active) {
      overlayState('error', { message: 'A speed test is running. Finish it first.' }, 2600);
      return;
    }
    const s = store.getSettings();
    if (!getKey()) {
      overlayState('error', { message: 'Add your OpenRouter key in JVoice first.' }, 2600);
      showMain('home');
      return;
    }
    const id = ++this.session;
    hush(); // talking over JVoice interrupts it
    clearTimeout(assistantHideTimer);
    if (agentMode(s)) loadStartApps();
    this.target = win32 ? win32.foregroundWindow() : null;
    this.setState('recording');
    this.startedAt = Date.now();
    this.liveAt = 0; // set when the microphone is actually capturing
    this.handsFree = false;
    showOverlay();
    toOverlay('rec:start', { id, deviceId: s.micDeviceId, sounds: s.sounds, maxSeconds: s.maxRecordSeconds });
    // While the user talks: open the connection to OpenRouter and copy the clipboard, so neither
    // delays the paste later.
    session.defaultSession.preconnect({ url: 'https://openrouter.ai', numSockets: 1 });
    this.clip = null;
    if (win32 && s.outputMode === 'paste' && s.restoreClipboard) {
      // A short wait keeps a slow clipboard (Office renders on request) from delaying the start.
      setTimeout(async () => {
        if (id !== this.session || this.state !== 'recording') return;
        const seq = win32.clipboardSequence();
        let snap = null;
        try { snap = await win32.snapshotClipboard(); } catch { /* clipboard busy: taken again at paste time */ }
        if (id === this.session && this.state !== 'idle') this.clip = { seq, snap };
      }, 250);
    }
  },

  interrupt() {
    // Extra key pressed while holding the combo: treat a fresh start as an accidental trigger.
    if (this.state === 'recording' && Date.now() - this.startedAt < 1500) this.cancel(true);
  },

  cancel(silent = false) {
    hush();
    if (this.state === 'idle') {
      if (hotkey.speaking) { hotkey.speaking = false; overlayState('hidden'); }
      return;
    }
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
    // A pre-opened socket that sat unused through a long recording may be closed; open one again.
    session.defaultSession.preconnect({ url: 'https://openrouter.ai', numSockets: 1 });
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
      if (rec.ms < 350) return fail('Too short. Nothing was recorded.', 1800);
      if (rec.peak < 0.01) {
        reportIssue('JVoice heard only silence from your microphone. Check the input device in Settings.', 'mic');
        return fail('No sound from the microphone. Check Settings.', 3000);
      }
      // The IPC copy is already a fresh buffer, so wrap it instead of copying again.
      const wav = Buffer.from(rec.wav.buffer, rec.wav.byteOffset, rec.wav.byteLength);
      if (agentMode()) {
        await runAgentTask({ wav, ms: rec.ms, signal: ac.signal, target: this.target, current });
        if (lastIssue && lastIssue.action !== 'history' && current()) reportIssue(null);
        return;
      }
      const result = await runPipeline({ wav, ms: rec.ms, signal: ac.signal, onStage: (st, data) => { if (current()) overlayState(st, data); } });
      if (ac.signal.aborted || !current()) return;
      if (!result.final) return fail('No speech detected.', 1800);
      const out = await output(result.final, { signal: ac.signal, target: this.target, clip: this.clip });
      this.clip = null;
      // Refresh the History list only after the paste, so its queries never compete with it.
      toMain('history:changed');
      if (ac.signal.aborted || !current()) return;
      if (lastIssue && lastIssue.action !== 'history') reportIssue(null);
      const note = out.note || (result.aiError ? 'AI cleanup failed, so the raw text was used.' : '');
      overlayState('done', { words: result.words, pasted: out.pasted, note, style: result.style, changed: result.changed, cut: result.cut }, note || result.cut ? 3000 : 1500);
      toMain('dictation:done', { raw: result.raw, final: result.final, style: result.style, aiError: result.aiError, cut: result.cut });
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
    raw = api.applyDictionary(api.stripSoundTags(t.text), dict);
    cost += t.cost;
  } catch (err) {
    if (signal?.aborted) throw err;
    if (s.keepHistory) {
      let row = historyId ? store.getHistoryItem(historyId) : null;
      if (!row) {
        row = store.addHistory({ ...base, status: 'failed', error: err.message });
        fs.writeFileSync(path.join(failedDir, `${row.id}.wav`), wav);
        store.updateHistory(row.id, { audio_path: `${row.id}.wav` });
      } else store.updateHistory(row.id, { error: err.message });
      toMain('history:changed');
      err.saved = true; // the recording is in History with Retry
    }
    throw err;
  }

  let final = raw;
  let aiError = '';
  if (raw && s.aiEnabled) {
    onStage('improving', { style: s.aiStyle });
    try {
      const r = await api.improve({ key, model: s.aiModel, text: raw, style: s.aiStyle, customPrompt: s.aiCustomPrompt, terms, charLimit: s.charLimit, signal });
      cost += r.cost;
      final = api.applyDictionary(r.text, dict) || raw;
    } catch (err) {
      if (signal?.aborted) throw err;
      aiError = err.message;
    }
  }

  final = api.sanitizeOutput(final);
  const capped = api.capLength(final, s.charLimit);
  const cut = capped !== final ? s.charLimit : 0;
  final = capped;
  const words = api.countWords(final);
  const style = s.aiEnabled && !aiError ? s.aiStyle : 'raw';
  if (s.keepHistory && final) {
    const fields = { status: 'done', raw, final, style, cut, error: aiError ? `AI cleanup failed: ${aiError}` : '', ai_model: style !== 'raw' ? s.aiModel : '', words, cost };
    if (historyId) {
      const old = store.getHistoryItem(historyId);
      if (old?.audio_path) removeAudio(old.audio_path);
      store.updateHistory(historyId, { ...fields, audio_path: '' });
    } else store.addHistory({ ...base, ...fields });
  }
  return { raw, final, words, cost, aiError, cut, style, changed: final !== raw };
}

// ---------- agent mode (beta) ----------
// The spoken task is transcribed (no cleanup) and handed to agent.cjs, which sees the screen and acts.
const agentMode = (s = store.getSettings()) => BETA && s.mode === 'agent';
function setMode(mode) {
  store.setSettings({ mode });
  forgetConvo();
  buildTrayMenu();
  toMain('settings:changed', publicSettings());
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new Error('Cancelled.'));
  const t = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
  const stop = () => { clearTimeout(t); reject(new Error('Cancelled.')); };
  signal?.addEventListener('abort', stop, { once: true });
});

// Screenshots are scaled down to about this size, which vision models read quickly and well.
const SHOT_W = 1280, SHOT_H = 800;
const OUTPUT_LIMIT = 6000;

// Start menu apps (name -> AppID), so "open spotify" works for Store apps too. Read once in the
// background when an agent recording starts, and kept for ten minutes.
let startApps = null;
function loadStartApps() {
  if (startApps && Date.now() - startApps.at < 600000) return startApps.p;
  const p = new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress'],
      { windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        let list = [];
        try { list = [].concat(JSON.parse(stdout || '[]')).filter((a) => a && a.Name && a.AppID); } catch { /* none */ }
        resolve(list);
      });
  });
  startApps = { at: Date.now(), p };
  return p;
}
// Best Start menu match for a spoken app name: exact name, then starts with, then contains.
function findStartApp(list, name) {
  const n = name.toLowerCase().replace(/\.exe$/, '').trim();
  const by = (f) => list.find((a) => f(a.Name.toLowerCase()));
  return by((x) => x === n) || by((x) => x.startsWith(`${n} `) || x.startsWith(n)) || (n.length >= 4 ? by((x) => x.includes(n)) : null);
}
const OPEN_SCHEMES = /^(https?|mailto|ms-settings|ms-windows-store|spotify|steam|discord|msteams|slack|zoommtg|calculator|ms-clock|ms-photos|onenote|outlookmail|microsoft-edge):/i;
// Files that run code when opened. Opening one asks first (or is refused when commands are off), so a
// web page or document on screen cannot talk the agent into starting a downloaded program.
const SCRIPT_EXT = new Set(['.exe', '.pif', '.jar', '.msc', '.appref-ms', '.application', '.bat', '.cmd', '.ps1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.msi', '.msix', '.appx', '.reg', '.hta', '.scr', '.com', '.cpl']);
const SHELL_APPS = new Set(['cmd', 'powershell', 'pwsh', 'wscript', 'cscript', 'mshta', 'rundll32', 'regsvr32', 'reg', 'regedit', 'bash', 'wsl']);

// The real computer for agent.cjs: the screen the cursor was on, the mouse and keyboard, PowerShell.
function agentIo({ signal, target, say = () => {} }) {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const title = win32 ? win32.windowTitle() : '';
  let map = null; // screenshot pixels -> physical screen pixels
  const toScreen = (x, y) => [map.x + (x + 0.5) * map.sx, map.y + (y + 0.5) * map.sy];
  // Our own key presses must not read as the user pressing Esc to stop the agent.
  const quiet = async (fn) => { hotkey.muteUntil = Date.now() + 5000; try { return await fn(); } finally { hotkey.muteUntil = Date.now() + 400; } };
  const need = () => { if (!win32) throw new Error('Mouse and keyboard control is not available.'); };
  // Asks before something that runs code (commands, scripts), unless commands are set to always allow.
  const allowed = async (message, detail) => {
    const mode = store.getSettings().agentCommands;
    if (mode === 'off') return false;
    if (mode === 'allow') return true;
    const { response } = await dialog.showMessageBox({
      type: 'question', title: 'JVoice Agent', buttons: ['Run it', 'Do not run'], defaultId: 1, cancelId: 1, noLink: true,
      message, detail: detail.slice(0, 2000),
    });
    if (signal.aborted) throw new Error('Cancelled.');
    return response === 0;
  };
  return {
    window: () => ({ title, exe: target?.exe || '' }),
    say,
    async open(t) {
      if (OPEN_SCHEMES.test(t)) {
        if (/^https?:/i.test(t)) { try { new URL(t); } catch { throw new Error('That is not a valid link.'); } }
        await shell.openExternal(t);
        return `Opened ${t}.`;
      }
      if (/^[a-z][a-z0-9+.-]*:(?![\\/])/i.test(t)) throw new Error('JVoice does not open that kind of link.');
      const file = t.replace(/^"(.*)"$/, '$1').replace(/^~(?=[\\/])/, app.getPath('home'));
      if (/[\\/]/.test(file) && fs.existsSync(file)) {
        if (SCRIPT_EXT.has(path.extname(file).toLowerCase()) && !(await allowed('JVoice Agent wants to run this file:', file))) return 'The user did not allow running this file.';
        const err = await shell.openPath(file);
        if (err) throw new Error(err);
        return `Opened ${file}.`;
      }
      if (!/^[\p{L}\p{N} ._+&'-]{1,60}$/u.test(t)) throw new Error('Give a link, a file path or an app name.');
      if (SHELL_APPS.has(t.toLowerCase().replace(/\.exe$/, ''))) throw new Error('Use run_command for command lines.');
      const hit = findStartApp(await loadStartApps(), t);
      if (hit) {
        execFile('explorer.exe', [`shell:AppsFolder\\${hit.AppID}`], { windowsHide: true }, () => {});
        return `Opened ${hit.Name}.`;
      }
      // Not in the Start menu: let Windows find it (App Paths and PATH, like Win+R does).
      return new Promise((resolve, reject) => {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $args[0]', t],
          { windowsHide: true, timeout: 15000 }, (err, _o, stderr) => (err ? reject(new Error(`Could not find an app called "${t}".`)) : resolve(`Opened ${t}.${stderr ? ` ${stderr.trim()}` : ''}`)));
      });
    },
    async screenshot(settleMs = 200) {
      if (settleMs) await sleep(settleMs, signal); // let the screen finish drawing after the last action
      const phys = screen.dipToScreenRect(null, display.bounds);
      const scale = Math.min(1, SHOT_W / phys.width, SHOT_H / phys.height);
      const outW = Math.round(phys.width * scale), outH = Math.round(phys.height * scale);
      if (win32?.captureScreen) {
        try {
          const img = nativeImage.createFromBitmap(win32.captureScreen(phys.x, phys.y, phys.width, phys.height, outW, outH), { width: outW, height: outH });
          map = { x: phys.x, y: phys.y, sx: phys.width / outW, sy: phys.height / outH };
          return { width: outW, height: outH, dataUrl: `data:image/jpeg;base64,${img.toJPEG(75).toString('base64')}` };
        } catch (err) { console.error('fast screenshot failed, using desktopCapturer', err.message); }
      }
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(phys.width * scale), height: Math.round(phys.height * scale) } });
      const src = sources.find((x) => x.display_id === String(display.id)) || sources[0];
      if (!src || src.thumbnail.isEmpty()) throw new Error('JVoice could not take a screenshot.');
      const { width, height } = src.thumbnail.getSize();
      map = { x: phys.x, y: phys.y, sx: phys.width / width, sy: phys.height / height };
      return { width, height, dataUrl: `data:image/jpeg;base64,${src.thumbnail.toJPEG(80).toString('base64')}` };
    },
    click: (x, y, button, clicks) => { need(); return quiet(() => win32.click(...toScreen(x, y), button, clicks)); },
    scroll: (x, y, dy, dx) => { need(); return quiet(() => win32.scroll(...toScreen(x, y), dy, dx)); },
    typeText: (text) => { need(); return quiet(() => win32.typeText(api.sanitizeOutput(text))); },
    keys: (keys) => { need(); return quiet(() => win32.sendKeys(keys)); },
    wait: (ms) => sleep(ms, signal),
    async run(command) {
      if (!(await allowed('JVoice Agent wants to run this PowerShell command:', command))) return 'The user did not allow this command. Do the task another way, or tell them.';
      return new Promise((resolve) => {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
          { windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024, signal },
          (err, stdout, stderr) => {
            const out = `${stdout || ''}${stderr ? `\n[stderr]\n${stderr}` : ''}`.trim();
            const code = err ? (err.killed ? 'timed out after 60 seconds' : `exit code ${err.code ?? 1}`) : 'exit code 0';
            resolve(`${code}\n${out.length > OUTPUT_LIMIT ? `${out.slice(0, OUTPUT_LIMIT)}\n(output cut)` : out || '(no output)'}`);
          });
      });
    },
    async write(text) {
      const out = await output(api.sanitizeOutput(text), { signal, target });
      return out.pasted ? `Pasted into the user's window.${out.note ? ` ${out.note}` : ''}` : `Copied to the clipboard instead. ${out.note || ''}`.trim();
    },
  };
}

// The conversation so far, so a follow up ("and turn it up") knows what "it" is.
let convo = null; // { history, at, model }
const forgetConvo = () => { convo = null; };

// Speech: the overlay page speaks with the Windows voices (no network, starts in a few milliseconds).
function speak(text) {
  const s = store.getSettings();
  if (AGENT_ARG > 0) console.log(`[say +${Date.now() - (speakClock || Date.now())}ms] ${text}`);
  if (!s.agentSpeak || !text) return;
  hotkey.speaking = true;
  toOverlay('assistant:say', { text, voice: s.agentVoice, rate: s.agentRate });
}
let speakClock = 0;
const hush = () => { hotkey.speaking = false; toOverlay('assistant:hush'); };

// The assistant card on screen: what the user said, what JVoice is saying, and what it is doing.
let assistantHideTimer = null;
let assistantEnded = false; // the run finished; the card only waits for the voice now
const hideAssistant = (ms) => {
  clearTimeout(assistantHideTimer);
  assistantHideTimer = setTimeout(() => {
    if (assistantEnded && dictation.state !== 'recording') {
      hotkey.speaking = false;
      overlayState('hidden');
      if (AGENT_ARG > 0) console.log(`[card hidden +${Date.now() - speakClock}ms]`);
    }
  }, ms);
};
function assistantView(view) {
  clearTimeout(assistantHideTimer);
  assistantEnded = false;
  overlayState('assistant', view);
}
// After the reply, the card stays until the voice finishes (the overlay says so), then fades.
// The voice can fail to report its end, so the card also hides after about as long as the
// reply takes to say, plus a few seconds to read it.
function assistantDone(view) {
  assistantView(view);
  assistantEnded = true;
  const s = store.getSettings();
  const words = api.countWords(view.reply || '');
  hideAssistant(s.agentSpeak ? Math.min(30000, 4000 + (words / 2.6 / (s.agentRate || 1)) * 1000) : Math.min(12000, 4000 + words * 150));
}
ipcMain.on('assistant:idle', (e) => {
  if (!overlayWin || e.sender !== overlayWin.webContents) return;
  hotkey.speaking = false;
  if (assistantEnded) hideAssistant(2500);
});

// text: a typed task for the --agent test mode, used instead of transcribing wav.
async function runAgentTask({ wav, ms, signal, target, current, text = null }) {
  const s = store.getSettings();
  const key = getKey();
  speakClock = Date.now();
  const view = { phase: 'listening', task: '', reply: '', action: '' };
  const show = () => { if (current()) assistantView({ ...view }); };
  show();
  // The card stays out of the agent's screenshots, so it never covers what the agent needs to see.
  const ov = overlayWin && !overlayWin.isDestroyed() ? overlayWin : null;
  ov?.setContentProtection(true);
  const io = agentIo({ signal, target, say: speak });
  // The screenshot is taken while the speech is transcribed, so it costs no time.
  const firstShot = io.screenshot(0);
  firstShot.catch(() => {});
  if (AGENT_ARG > 0) { console.log(`[model ${s.agentModel}]`); firstShot.then(() => console.log(`[screenshot +${Date.now() - speakClock}ms]`), () => {}); }
  let r, t;
  try {
    t = text !== null ? { text, cost: 0 } : await api.transcribe({ key, model: s.sttModel, wav, language: s.language, signal });
    const task = api.applyDictionary(api.stripSoundTags(t.text), store.listDictionary()).trim();
    if (signal.aborted || !current()) return;
    if (!task) { overlayState('error', { message: 'No speech detected.' }, 1800); return; }
    view.task = task;
    view.phase = 'thinking';
    show();
    const history = convo && convo.model === s.agentModel && Date.now() - convo.at < agent.FOLLOW_UP_MS ? convo.history : [];
    r = await agent.runAgent({
      chat: AGENT_ARG > 0 ? async (o) => { const x = await api.chatStream(o); console.log(`[answered by ${x.model}]`); return x; } : api.chatStream,
      key, model: s.agentModel, task, io, signal, history, firstShot,
      allowCommands: s.agentCommands !== 'off',
      onStep: (label, step) => {
        view.action = step || label !== 'Listening' ? label : '';
        if (label === 'Thinking' || label === 'Listening') { view.phase = 'thinking'; view.action = ''; } else view.phase = 'acting';
        show();
      },
      onText: (_d, turnText) => { if (AGENT_ARG > 0 && turnText === _d) console.log(`[first text +${Date.now() - speakClock}ms]`); view.reply = turnText; view.phase = 'speaking'; show(); },
    });
    r.task = task;
  } catch (err) {
    if (signal.aborted) return;
    err.message = `Agent: ${err.message}`;
    speak('Sorry, something went wrong.');
    throw err;
  } finally { ov?.setContentProtection(false); }
  if (signal.aborted || !current()) return;
  convo = { history: agent.trimHistory(r.history), at: Date.now(), model: s.agentModel };
  if (s.keepHistory) {
    store.addHistory({
      status: 'done', style: 'agent', raw: r.task, final: r.written || r.summary, error: r.success ? '' : r.summary,
      stt_model: s.sttModel, ai_model: s.agentModel, duration_ms: ms, words: api.countWords(r.task), cost: t.cost + r.cost,
    });
    toMain('history:changed');
  }
  assistantDone({ phase: r.success ? 'done' : 'stopped', task: r.task, reply: r.summary, action: '', speaking: !!s.agentSpeak });
  const { history: _h, ...out } = r;
  toMain('agent:done', out);
  return out;
}

// ---------- speed test ----------
// The Speed test page records and cuts the audio into pieces at pauses. Main transcribes each piece
// with the speech model (no chat AI) and counts its words and characters.
const speedTest = {
  active: false,
  abort: null,

  setActive(on) {
    if (on === this.active) return;
    this.active = on;
    if (this.abort) { this.abort.abort(); this.abort = null; }
    if (on) this.abort = new AbortController();
    // A test keeps running while the window is hidden in the tray, so the page must not be throttled.
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.setBackgroundThrottling(!on);
    buildTrayMenu();
    broadcastStatus();
  },

  // Returns { text, words, chars, cost }, or { error, fatal } when the piece could not be transcribed.
  // fatal: the key or credits are the problem (or the test ended), so the rest would fail too.
  async transcribe(wav) {
    const bad = speed.checkPiece(wav);
    if (bad) throw new Error(bad);
    if (!this.active) return { error: 'The speed test is not running.', fatal: true };
    const key = getKey();
    if (!key) return { error: 'Add your OpenRouter key first.', fatal: true };
    const s = store.getSettings();
    const { signal } = this.abort;
    const audio = Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength);
    for (let attempt = 0; ; attempt++) {
      try {
        const t = await api.transcribe({ key, model: s.sttModel, wav: audio, language: s.language, signal });
        const text = api.stripSoundTags(t.text);
        return { text, ...speed.speechCounts(text, s.language), cost: t.cost };
      } catch (err) {
        if (signal.aborted) return { error: 'Cancelled.', fatal: true };
        const fatal = [401, 402, 403].includes(err.status);
        if (fatal || err.status === 400 || attempt >= 2) return { error: err.message, fatal };
        // Network trouble or a busy provider: wait a little and send the piece again.
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        if (signal.aborted) return { error: 'Cancelled.', fatal: true };
      }
    }
  },

  // Words and characters are counted again here from the transcript, so the saved numbers never
  // depend on the page.
  save(r) {
    const s = store.getSettings();
    const transcript = String(r?.transcript ?? '').slice(0, 1000000).trim();
    const cap = (v) => Math.min(speed.MAX_TEST_SECONDS + 60, Math.max(0, Number(v) || 0));
    const seconds = cap(r?.seconds);
    if (seconds < 1) throw new Error('The test was too short to measure.');
    const counts = speed.speechCounts(transcript, s.language);
    if (!counts.words) throw new Error('No speech was heard.');
    return store.addSpeedTest({
      planned_seconds: speed.plannedSeconds(r?.planned), seconds, missed_seconds: cap(r?.missed),
      ...counts, ...speed.rates({ ...counts, seconds }), transcript,
      language: s.language, stt_model: s.sttModel, cost: Math.max(0, Number(r?.cost) || 0),
    });
  },
};

// History rows store only the WAV file name. Anything else is resolved inside failedDir, so a bad
// row can never point JVoice at another file.
function audioFile(name) {
  const base = path.basename(String(name || ''));
  return /^\d+\.wav$/.test(base) ? path.join(failedDir, base) : null;
}
function removeAudio(name) {
  const f = audioFile(name);
  if (f) fs.rm(f, { force: true }, () => {});
}

// Puts the text into the app the user was in. Falls back to copy-only whenever pasting could go wrong.
async function output(text, { signal, target, clip } = {}) {
  const s = store.getSettings();
  if (s.outputMode !== 'paste') { clipboard.writeText(text); return { pasted: false }; }
  let note = '';
  if (target && api.isTerminal(target.exe, target.cls)) {
    text = api.forTerminal(text);
    if (/[\n\u2028\u2029]/.test(text)) note = 'Pasted as one line, since this is a terminal.';
    text = api.oneLine(text);
  }
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
    // Reuse the copy taken when recording started, unless something was copied since.
    if (clip && clip.seq === win32.clipboardSequence()) snap = clip.snap;
    else { try { snap = await win32.snapshotClipboard(); } catch { snap = null; } }
  }
  // The snapshot can wait on another app's clipboard lock, so check everything again right before pasting.
  if (signal?.aborted) return { pasted: false };
  // Text that is only on the clipboard for the paste stays out of Windows clipboard history.
  let written = false;
  if (win32 && s.restoreClipboard && snap) { try { written = await win32.setClipboardText(text, clipboardOwner()); } catch { written = false; } }
  if (!written) clipboard.writeText(text);
  if (!sameWindow()) { if (written) clipboard.writeText(text); return switched; }
  if (hotkey.modifiersDown()) { if (written) clipboard.writeText(text); return { pasted: false, note: 'Keys were still held, so the text was copied instead.' }; }
  const seq = win32 ? win32.clipboardSequence() : 0;
  hotkey.paste();
  if (snap) {
    setTimeout(async () => {
      // Only put the old clipboard back if nothing else was copied in the meantime (checked under the clipboard lock).
      try { await win32.restoreClipboard(snap, clipboardOwner(), seq); } catch (err) { console.error('clipboard restore failed', err.message); }
    }, 700);
  }
  return { pasted: true, note };
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
  // Only JVoice's own pages may call into main.
  const fromApp = (e) => String(e.senderFrame?.url || '').startsWith(UI_URL);
  const handle = (ch, fn) => ipcMain.handle(ch, async (e, ...args) => {
    if (!fromApp(e)) return { ok: false, error: 'Blocked.' };
    try { return { ok: true, data: await fn(...args) }; } catch (err) { return { ok: false, error: err.message || String(err) }; }
  });
  const fromOverlay = (e) => !!overlayWin && !overlayWin.isDestroyed() && e.sender === overlayWin.webContents;
  const str = (v, max) => String(v ?? '').slice(0, max);
  const MODEL_ID = /^[\w.:~/-]{1,120}$/;

  handle('settings:get', () => publicSettings());
  handle('settings:set', (patch) => {
    const clean = { ...patch };
    delete clean.apiKeyEnc;
    delete clean.lastVersion;
    delete clean.updateNotes;
    if (clean.hotkey) {
      const msg = validateCombo(clean.hotkey);
      if (msg) throw new Error(msg);
      clean.hotkey = sortCombo(clean.hotkey);
    }
    if (clean.hotkeyMode && !['hold', 'toggle'].includes(clean.hotkeyMode)) delete clean.hotkeyMode;
    if (clean.aiStyle && !['clean', 'rewrite'].includes(clean.aiStyle)) delete clean.aiStyle;
    if (clean.outputMode && !['paste', 'copy'].includes(clean.outputMode)) delete clean.outputMode;
    if ('mode' in clean && (!BETA || !['voice', 'agent'].includes(clean.mode))) delete clean.mode;
    if (clean.agentCommands && !['ask', 'allow', 'off'].includes(clean.agentCommands)) delete clean.agentCommands;
    if ('agentVoice' in clean) clean.agentVoice = str(clean.agentVoice, 200);
    if ('agentRate' in clean) clean.agentRate = Math.min(2, Math.max(0.6, Number(clean.agentRate) || 1.15));
    if ('charLimit' in clean && ![0, 128, 280, 500, 1024].includes(Number(clean.charLimit))) delete clean.charLimit;
    else if ('charLimit' in clean) clean.charLimit = Number(clean.charLimit);
    for (const k of ['sttModel', 'aiModel', 'agentModel']) {
      if (!(k in clean)) continue;
      clean[k] = str(clean[k], 200).trim() || DEFAULTS[k];
      if (!MODEL_ID.test(clean[k])) throw new Error('That is not a valid model id.');
    }
    if ('language' in clean) clean.language = str(clean.language, 8).trim().toLowerCase().replace(/[^a-z-]/g, '');
    if ('aiCustomPrompt' in clean) clean.aiCustomPrompt = str(clean.aiCustomPrompt, 4000);
    if ('micDeviceId' in clean) clean.micDeviceId = str(clean.micDeviceId, 256);
    if ('speedLength' in clean) clean.speedLength = speed.plannedSeconds(clean.speedLength);
    if ('maxRecordSeconds' in clean) clean.maxRecordSeconds = Math.min(600, Math.max(5, Math.round(Number(clean.maxRecordSeconds)) || 600));
    for (const k of ['aiEnabled', 'restoreClipboard', 'sounds', 'launchAtLogin', 'keepHistory', 'closeHintShown', 'agentSpeak']) {
      if (k in clean) clean[k] = !!clean[k];
    }
    store.setSettings(clean);
    if ('launchAtLogin' in clean) applyLoginItem(!!clean.launchAtLogin);
    if (clean.hotkey || clean.hotkeyMode) applyHotkeySettings();
    if ('mode' in clean) { buildTrayMenu(); forgetConvo(); }
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

  handle('history:list', (query, limit) => store.listHistory({ query: str(query, 200).trim(), limit: Math.min(200, Math.max(1, Number(limit) || 200)) }));
  handle('history:delete', (id) => {
    const row = store.deleteHistory(id);
    if (row?.audio_path) removeAudio(row.audio_path);
    return true;
  });
  handle('history:clear', () => {
    for (const f of store.clearHistory()) removeAudio(f);
    return true;
  });
  handle('history:retry', async (id) => {
    const row = store.getHistoryItem(id);
    const file = audioFile(row?.audio_path);
    if (!file || !fs.existsSync(file)) throw new Error('The recording for this entry is gone.');
    const wav = fs.readFileSync(file);
    const r = await runPipeline({ wav, ms: row.duration_ms, historyId: id });
    if (r.final) clipboard.writeText(r.final);
    return r;
  });
  handle('speed:active', (on) => { speedTest.setActive(!!on); return true; });
  handle('speed:transcribe', (wav) => speedTest.transcribe(wav));
  handle('speed:save', (r) => speedTest.save(r));
  handle('speed:list', () => store.listSpeedTests(50));
  handle('speed:delete', (id) => { store.deleteSpeedTest(Number(id)); return true; });
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
  handle('update:state', () => updater?.state ?? { status: 'dev', version: app.getVersion() });
  handle('update:check', () => updater?.check());
  handle('update:restart', () => updater?.restartNow() ?? false);
  handle('open:external', (url) => {
    if (!SAFE_LINK.test(url)) throw new Error('Blocked link.');
    return shell.openExternal(url);
  });
  handle('open:mic-settings', () => shell.openExternal('ms-settings:privacy-microphone'));

  // Overlay recorder events (fire and forget).
  ipcMain.on('rec:done', (e, rec) => { if (fromOverlay(e)) dictation.onRecorded(rec); });
  ipcMain.on('rec:error', (e, err) => { if (fromOverlay(e)) dictation.onRecorderError({ id: err?.id, message: str(err?.message ?? 'The microphone failed.', 300) }); });
  ipcMain.on('rec:live', (e, id) => { if (fromOverlay(e)) dictation.onLive(id); });
ipcMain.on('rec:limit', (e, id) => { if (fromOverlay(e) && id === dictation.session) dictation.stop(); });
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
    try { await loadPage(w, page); } catch (err) {
      report.pages[page] = { errors: [`load failed: ${err.message}`] };
      w.destroy();
      continue;
    }
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
      await loadPage(win, 'index.html');
      for (const page of ['home', 'speed', 'history', 'dictionary', 'settings']) {
        win.webContents.send('nav', page);
        await shot(win, `${theme}-${w}-${page}`);
        if (page === 'history') {
          await win.webContents.executeJavaScript(`[...document.querySelectorAll('#histList button')].find((b) => b.textContent === 'Show changes')?.click()`);
          await shot(win, `${theme}-${w}-${page}-changes`);
        }
        if (page === 'settings') {
          if (process.env.JVOICE_SHOTS_TYPE) {
            // Types extra instructions like a user would, then reports what was saved (live save check).
            await win.webContents.executeJavaScript(`(() => { const t = document.getElementById('aiCustom'); t.focus(); t.value = ${JSON.stringify(process.env.JVOICE_SHOTS_TYPE)}; t.dispatchEvent(new Event('input')); })()`);
            await new Promise((r) => setTimeout(r, 1200));
            const shown = await win.webContents.executeJavaScript(`document.getElementById('customSaved').textContent`);
            process.stdout.write(`typed: saved=${JSON.stringify(store.getSettings().aiCustomPrompt)} status=${JSON.stringify(shown)}\n`);
          }
          if (process.env.JVOICE_SHOTS_UPDATE) {
            // Presses Check for updates against the real GitHub feed, as a dev copy of the given version.
            // The wide window presses the sidebar button, the narrow one the button in Settings.
            updater = new Updater({ app: { isPackaged: false, getVersion: () => process.env.JVOICE_SHOTS_UPDATE }, isBusy: () => false, fetch: (url) => net.fetch(url) });
            updater.on('state', (st) => win.webContents.send('update', st));
            win.webContents.send('update', updater.state);
            const which = w === 980 ? 'sideUpdate' : 'updAction';
            await win.webContents.executeJavaScript(`document.getElementById('${which}').click()`);
            for (let i = 0; i < 50 && ['dev', 'checking'].includes(updater.state.status); i++) await new Promise((r) => setTimeout(r, 200));
            const shown = await win.webContents.executeJavaScript(`[document.getElementById('updStatus').textContent, document.getElementById('updAction').textContent, document.getElementById('sideUpdateText').textContent]`);
            process.stdout.write(`update: ${JSON.stringify({ clicked: which, status: updater.state.status, next: updater.state.next, shown })}\n`);
            await win.webContents.executeJavaScript(`document.getElementById('g-upd').scrollIntoView()`);
            await shot(win, `${theme}-${w}-${page}-updates`);
          }
          for (const y of [700, 1400]) {
            await win.webContents.executeJavaScript(`document.getElementById('main').scrollTop = ${y}`);
            await shot(win, `${theme}-${w}-${page}-scroll${y}`);
          }
        }
      }
      win.destroy();
    }
    const ov = new BrowserWindow({ show: false, width: OVERLAY_W, height: OVERLAY_H, transparent: true, frame: false, webPreferences: { offscreen: true, preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true } });
    await loadPage(ov, 'overlay.html');
    const states = [
      ['recording', `document.getElementById('pill').dataset.state='recording';document.querySelectorAll('.wave i').forEach((b,i)=>b.style.transform='scaleY('+(0.2+0.8*Math.abs(Math.sin(i/2)))+')');document.getElementById('time').textContent='0:07'`],
      ['handsfree', `pill.dataset.free='1';label.textContent='Ctrl + Win to stop'`],
      ['transcribing', `render('transcribing')`], ['improving', `render('improving')`],
      ['done', `render('done',{words:42,pasted:true})`], ['copied', `render('done',{words:1,pasted:false})`],
      ['error', `render('error',{message:'Your OpenRouter account is out of credits.'})`],
      ['error-long', `render('error',{message:'Microphone access is blocked. Allow it in Windows privacy settings.'})`],
      ['agent', `render('agent',{label:'Pressing Ctrl+L',sub:'Step 3. Esc stops.'})`],
      ['agentdone', `render('agentdone',{success:true,summary:'Opened Notepad and wrote a short haiku about rain, then saved it to your Desktop.'})`],
      ['agentstopped', `render('agentdone',{success:false,summary:'The site asks for a password, so I stopped.'})`],
      ['assistant-thinking', `renderCard({phase:'thinking',task:'Open Spotify and play my liked songs'})`],
      ['assistant-acting', `renderCard({phase:'acting',task:'Open Spotify and play my liked songs',reply:'Opening Spotify.',action:'Pressing Ctrl+L'})`],
      ['assistant-done', `card.classList.add('talking');renderCard({phase:'done',task:'What is the weather like for a run tomorrow morning in Seattle, and should I bring a jacket?',reply:'Tomorrow morning in Seattle looks cool and cloudy, around 48 degrees with a light breeze. A thin jacket is a good idea, and you can take it off once you warm up. Rain is not expected until the afternoon.'})`],
      ['assistant-stopped', `card.classList.remove('talking');renderCard({phase:'stopped',task:'Log into my bank',reply:'The site is asking for your password, so I stopped there.'})`],
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

// --speed-test <input.wav> <length> <stopAfterMs> <shotDir>: runs the real Speed test page in a hidden
// offscreen window, with the WAV as the microphone and real transcription through the saved key.
// <length> is a length button (30, 60, ... or 0 for "No limit"), or custom<minutes> such as custom2.
// stopAfterMs > 0 clicks Stop after that long.
// Prints what the page showed and the row it saved, screenshots each stage, then deletes the row
// with the page's Delete button.
async function runSpeedTest(length, stopAfterMs, dir) {
  fs.mkdirSync(dir, { recursive: true });
  registerIpc();
  mainWin = new BrowserWindow({ show: false, width: 980, height: 760, useContentSize: true, webPreferences: webPrefs({ offscreen: true }) });
  const wc = mainWin.webContents;
  const errors = [];
  wc.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message); });
  await loadPage(mainWin, 'index.html');
  const js = (code) => wc.executeJavaScript(code);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (name) => fs.writeFileSync(path.join(dir, `${name}.png`), (await wc.capturePage()).toPNG());
  const viewState = () => js(`document.getElementById('page-speed').dataset.state`);
  await wait(800);
  wc.send('nav', 'speed');
  await wait(600);
  await shot('1-setup');
  // "custom<minutes>" picks Custom and types the minutes, like a user would.
  const custom = /^custom(\d+)$/.exec(String(length));
  const len = custom ? 'custom' : String(length), minutes = custom ? custom[1] : '';
  await js(`document.querySelector('[data-len="${len}"]').click()`);
  if (minutes) await js(`(() => { const i = document.getElementById('speedCustom'); i.value = '${Number(minutes)}'; i.dispatchEvent(new Event('change')); })()`);
  await wait(400);
  await js(`document.getElementById('speedStart').click()`);
  const started = Date.now();
  const log = [];
  let shotAt = 0, stopped = false, finishingShot = false;
  for (;;) {
    await wait(1000);
    const st = await viewState();
    const nums = await js(`[...document.querySelectorAll('#speedRun dd')].map((d) => d.textContent).join(' | ') + ' @ ' + document.getElementById('speedTime').textContent`);
    log.push(`${Math.round((Date.now() - started) / 1000)}s ${st}: ${nums}`);
    process.stderr.write(`${log.at(-1)}\n`);
    if (st === 'running' && Date.now() - shotAt > 15000) { shotAt = Date.now(); await shot(`2-running-${Math.round((Date.now() - started) / 1000)}s`); }
    if (stopAfterMs > 0 && !stopped && st === 'running' && Date.now() - started >= stopAfterMs) { stopped = true; await js(`document.getElementById('speedStop').click()`); }
    if (st === 'finishing' && !finishingShot) { finishingShot = true; await shot('3-finishing'); }
    if (st === 'done' || st === 'idle' || Date.now() - started > 4 * 60 * 1000) break;
  }
  await wait(600);
  await shot('4-done');
  const shown = await js(`({
    state: document.getElementById('page-speed').dataset.state,
    result: [...document.querySelectorAll('#speedResult dt')].map((d) => d.textContent + ': ' + d.nextElementSibling.textContent),
    meta: document.getElementById('speedResultMeta').textContent,
    warn: document.getElementById('speedResultWarn').textContent,
    transcript: document.getElementById('speedTranscript').textContent,
    listed: document.querySelectorAll('#speedList .item').length,
    toast: document.getElementById('toast').className.includes('show') ? document.getElementById('toast').textContent : '',
  })`);
  const row = store.listSpeedTests(1)[0] || null;
  const saved = row && row.created_at >= started ? row : null;
  let deleted = null;
  if (saved) {
    await js(`document.querySelector('#speedList .item button[aria-label="Delete result"]').click()`);
    await wait(800);
    deleted = !store.listSpeedTests(50).some((r) => r.id === saved.id);
  }
  process.stdout.write(JSON.stringify({ log, shown, saved, deleted, speedActiveAfter: speedTest.active, errors }, null, 2) + '\n');
  app.exit(shown.state === 'done' && saved && deleted && !errors.length ? 0 : 1);
}

// --agent <task.wav | "typed task">: runs Agent mode for real (speech, model, screen, mouse and keyboard)
// with the saved key and settings, and prints what happened. Run it inside a VM: it controls the computer.
async function runAgentFile(arg) {
  try {
    if (!getKey()) throw new Error('No OpenRouter key saved. Add one in the app first.');
    const isWav = /\.wav$/i.test(arg) && fs.existsSync(arg);
    const wav = isWav ? readWav(arg) : null;
    // Typed tasks can be chained with "||" to test follow ups in one conversation.
    const tasks = isWav ? [null] : String(arg).split('||').map((x) => x.trim()).filter(Boolean);
    let r;
    for (const text of tasks) {
      const ac = new AbortController();
      const started = Date.now();
      r = await runAgentTask({
        wav, ms: wav ? Math.round(((wav.length - 44) / 32000) * 1000) : 0, signal: ac.signal,
        target: win32 ? win32.foregroundWindow() : null, current: () => true, text,
      });
      process.stdout.write(JSON.stringify({ ...r, ms: Date.now() - started }, null, 2) + '\n');
      // Let the voice finish before the next task or the exit (the overlay says when it is quiet).
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 30000);
        ipcMain.once('assistant:idle', () => { clearTimeout(t); console.log(`[voice finished +${Date.now() - started}ms]`); resolve(); });
      });
    }
    await new Promise((res) => setTimeout(res, 3500)); // lets the card's hide timer run
    app.exit(r?.success ? 0 : 1);
  } catch (err) {
    process.stderr.write(`ERROR: ${err.message}\n`);
    app.exit(1);
  }
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
  serveUi();
  store = new Store(path.join(app.getPath('userData'), 'jvoice.db'));
  failedDir = path.join(app.getPath('userData'), 'failed-audio');
  fs.mkdirSync(failedDir, { recursive: true });

  // Only our own pages ask for anything, and only the microphone (no camera, no screen capture).
  const ours = (url) => String(url || '').startsWith(UI_URL);
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb, details) => {
    const types = details?.mediaTypes ?? [];
    cb(perm === 'media' && ours(details?.requestingUrl || wc.getURL()) && types.length > 0 && types.every((t) => t === 'audio'));
  });
  session.defaultSession.setPermissionCheckHandler((wc, perm, origin, details) =>
    perm === 'media' && (!details?.mediaType || details.mediaType === 'audio') && ours(wc?.getURL() || details?.requestingUrl));
  api.setFetch((url, init) => net.fetch(url, init));
  // Failed recordings are kept for Retry, but not forever.
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  fs.readdir(failedDir, (err, names) => {
    for (const n of err ? [] : names) {
      const f = path.join(failedDir, n);
      fs.stat(f, (e, st) => { if (!e && st.mtimeMs < cutoff) fs.rm(f, { force: true }, () => {}); });
    }
  });

  if (SMOKE) return runSmoke();
  if (TRANSCRIBE_ARG > 0) return runTranscribeFile(process.argv[TRANSCRIBE_ARG + 1]);
  if (IMPORT_KEY) {
    // Headless key import for setup scripts: reads JVOICE_IMPORT_KEY, checks it with OpenRouter, stores it encrypted.
    try {
      const key = String(process.env.JVOICE_IMPORT_KEY || '').trim();
      const info = await api.keyInfo(key);
      setKey(key);
      process.stdout.write(`key saved (${maskKey(key)}, usage $${info.usage.toFixed(4)})\n`);
      return app.exit(0);
    } catch (err) { process.stderr.write(`ERROR: ${err.message}\n`); return app.exit(1); }
  }
  if (AGENT_ARG > 0) { createOverlay(); overlayWin.webContents.on('console-message', (e) => console.log(`[overlay] ${e.message ?? e}`)); return runAgentFile(process.argv[AGENT_ARG + 1]); }
  if (SPEED_ARG > 0) return runSpeedTest(process.argv[SPEED_ARG + 2], Number(process.argv[SPEED_ARG + 3]) || 0, path.resolve(process.argv[SPEED_ARG + 4] || 'speed-shots'));
  if (RECORD_ARG > 0) return runRecordTest(Number(process.argv[RECORD_ARG + 2]) || 4000, path.resolve(process.argv[RECORD_ARG + 3] || 'record-test.wav'));
  if (SHOTS_ARG > 0) return runShots(path.resolve(process.argv[SHOTS_ARG + 1] || 'shots'));

  registerIpc();
  applyHotkeySettings();
  hotkey.on('start', () => (hotkey.mode === 'hold' ? dictation.press() : dictation.start()));
  hotkey.on('stop', () => (hotkey.mode === 'hold' ? dictation.release() : dictation.stop()));
  hotkey.on('cancel', () => dictation.cancel());
  hotkey.on('interrupt', () => dictation.interrupt());
  try { hotkey.start(); } catch (err) { console.error('keyboard hook failed', err); }
  powerMonitor.on('lock-screen', () => { hotkey.reset(); if (dictation.state === 'recording') dictation.cancel(true); });
  powerMonitor.on('resume', () => { hotkey.reset(); updater?.check(); });

  createOverlay();
  // Started at login with a key saved: the main window is only made when the user opens it.
  const openNow = !START_HIDDEN || !getKey();
  if (openNow) createMainWindow();

  const prev = store.getSettings();
  const justUpdated = app.isPackaged && prev.lastVersion && prev.lastVersion !== app.getVersion()
    ? { version: app.getVersion(), notes: prev.updateNotes } : null;
  if (app.isPackaged) store.setSettings({ lastVersion: app.getVersion(), updateNotes: '' });
  updater = new Updater({ app, isBusy: () => dictation.state !== 'idle' || speedTest.active, fetch: (url) => net.fetch(url), justUpdated });
  updater.on('state', (st) => {
    toMain('update', st);
    buildTrayMenu();
    if (st.status === 'restarting') overlayState('updating', { version: st.next }, 0);
  });
  updater.on('before-restart', () => {
    store.setSettings({ updateNotes: updater.state.notes || '' });
    app.isQuitting = true;
    try { hotkey.stop(); } catch { /* already stopped */ }
  });
  updater.start();
  if (justUpdated && Notification.isSupported()) {
    const first = (justUpdated.notes || '').split('\n').find((l) => l.startsWith('- '));
    const n = new Notification({ title: `JVoice updated to ${justUpdated.version}`, body: first ? first.slice(2) : 'Open JVoice to see what changed.', icon: ICON });
    n.on('click', () => showMain('settings'));
    n.show();
  }

  tray = new Tray(trayIcon());
  tray.on('click', () => showMain());
  buildTrayMenu();

  const s = store.getSettings();
  if (openNow) mainWin.once('ready-to-show', () => showMain(getKey() ? null : 'home'));
  if (s.launchAtLogin) applyLoginItem(true);
});

app.on('before-quit', () => {
  app.isQuitting = true;
  try { hotkey.stop(); } catch { /* already stopped */ }
});
