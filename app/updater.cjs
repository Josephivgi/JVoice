'use strict';
// Updates from GitHub Releases (Josephivgi/JVoice). Checks at startup and every few hours, downloads in
// the background, then restarts JVoice into the new version as soon as no dictation is running.
//
// The installer is not Authenticode signed, so the sha512 in latest.yml (from the same release) only
// proves the download is intact. Each release also carries <installer>.sig, an Ed25519 signature made
// offline by scripts/release.cjs. JVoice installs only an update whose signature matches the key below.
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const OWNER = 'Josephivgi', REPO = 'JVoice';
const RELEASE_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEALfw9NCfPLMw5SCaUzy1428A7ofpD6RQahKcDakSQEdE=
-----END PUBLIC KEY-----`;
const CHECK_EVERY_MS = 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 15 * 1000;
const RESTART_COUNTDOWN_MS = 5 * 1000;

// The signed text: product, version, installer file name and its sha512. Shared with scripts/release.cjs.
const signedMessage = ({ version, file, sha512 }) => Buffer.from(`JVoice update\n${version}\n${file}\n${sha512}\n`, 'utf8');

function verifySignature({ version, file, sha512, signature, publicKey = RELEASE_KEY }) {
  try {
    return crypto.verify(null, signedMessage({ version, file, sha512 }), publicKey, Buffer.from(String(signature).trim(), 'base64'));
  } catch { return false; }
}

// GitHub hands the release notes over as HTML. The app shows them as plain text lines.
function notesToText(notes) {
  const html = Array.isArray(notes) ? notes.map((n) => n?.note || '').join('\n') : String(notes || '');
  return html
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/(p|li|h[1-6]|ul|ol)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&')
    .split('\n').map((l) => l.trim()).filter(Boolean).join('\n')
    .slice(0, 4000);
}

function sha512File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha512');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('base64')));
  });
}

class Updater extends EventEmitter {
  // isBusy: () => boolean, true while the user is dictating (the restart waits for idle).
  // fetch: used to download the signature (Electron's net.fetch in the app).
  // justUpdated: { version, notes } when this start is the first one after an update.
  constructor({ app, isBusy, fetch: fetchImpl = fetch, log = console, justUpdated = null }) {
    super();
    this.app = app;
    this.isBusy = isBusy;
    this.fetch = fetchImpl;
    this.log = log;
    this.state = { status: app.isPackaged ? 'idle' : 'dev', version: app.getVersion(), justUpdated };
    this.autoUpdater = null;
    this.timer = null;
    this.restartTimer = null;
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  start() {
    // A dev build runs electron.exe from the repo; there is nothing to install over.
    if (!this.app.isPackaged) return;
    const { autoUpdater } = require('electron-updater');
    this.autoUpdater = autoUpdater;
    // The feed is fixed here, never read from settings or the environment.
    autoUpdater.setFeedURL({ provider: 'github', owner: OWNER, repo: REPO, releaseType: 'release' });
    autoUpdater.autoDownload = true;
    // Installing on quit would skip the signature check, so installs only happen through install() below.
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.logger = null;

    autoUpdater.on('checking-for-update', () => this.setState({ status: 'checking', error: '' }));
    autoUpdater.on('update-not-available', () => this.setState({ status: 'current', checkedAt: Date.now() }));
    autoUpdater.on('update-available', (info) => this.setState({ status: 'downloading', next: info.version, percent: 0, notes: notesToText(info.releaseNotes) }));
    autoUpdater.on('download-progress', (p) => this.setState({ status: 'downloading', percent: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded', (info) => this.onDownloaded(info));
    autoUpdater.on('error', (err) => {
      this.log.error('update error', err?.message);
      this.setState({ status: 'error', error: friendly(err) });
    });

    setTimeout(() => this.check(), FIRST_CHECK_DELAY_MS);
    this.timer = setInterval(() => this.check(), CHECK_EVERY_MS);
  }

  async onDownloaded(info) {
    this.setState({ status: 'verifying', next: info.version });
    try {
      // The release asset name; the cached copy on disk may be named differently.
      const file = path.basename(decodeURIComponent(info.files?.[0]?.url || info.path || ''));
      if (!file || !info.downloadedFile) throw new Error('no downloaded file');
      const url = `https://github.com/${OWNER}/${REPO}/releases/download/v${info.version}/${encodeURIComponent(file)}.sig`;
      const res = await this.fetch(url);
      if (!res.ok) throw new Error(`signature download failed (${res.status})`);
      const signature = await res.text();
      const sha512 = await sha512File(info.downloadedFile);
      if (!verifySignature({ version: info.version, file, sha512, signature })) throw new Error('bad signature');
    } catch (err) {
      this.log.error('update rejected', err.message);
      this.setState({ status: 'error', error: 'The update could not be verified as coming from JVoice, so it was not installed.' });
      return;
    }
    this.setState({ status: 'ready', next: info.version, percent: 100 });
    this.restartWhenIdle();
  }

  async check() {
    if (!this.autoUpdater) return this.state;
    if (['checking', 'downloading', 'verifying', 'ready', 'restarting'].includes(this.state.status)) return this.state;
    try { await this.autoUpdater.checkForUpdates(); } catch (err) { this.setState({ status: 'error', error: friendly(err) }); }
    return this.state;
  }

  // Waits until no dictation is running, shows a short countdown, then installs and relaunches.
  restartWhenIdle() {
    clearTimeout(this.restartTimer);
    if (this.isBusy()) { this.restartTimer = setTimeout(() => this.restartWhenIdle(), 2000); return; }
    this.setState({ status: 'restarting', restartAt: Date.now() + RESTART_COUNTDOWN_MS });
    this.restartTimer = setTimeout(() => {
      if (this.isBusy()) { this.setState({ status: 'ready' }); this.restartWhenIdle(); return; }
      this.install();
    }, RESTART_COUNTDOWN_MS);
  }

  restartNow() {
    if (this.state.status !== 'ready' && this.state.status !== 'restarting') return false;
    clearTimeout(this.restartTimer);
    this.install();
    return true;
  }

  install() {
    this.emit('before-restart');
    // Silent install, then start the new version.
    this.autoUpdater.quitAndInstall(true, true);
  }

  stop() { clearInterval(this.timer); clearTimeout(this.restartTimer); }
}

function friendly(err) {
  const msg = String(err?.message || err || '');
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::/i.test(msg)) return 'Could not reach GitHub to check for updates.';
  if (/404/.test(msg)) return 'No published release was found yet.';
  if (/sha512|checksum/i.test(msg)) return 'The downloaded update did not match its checksum, so it was not installed.';
  return 'The update check failed. JVoice will try again later.';
}

module.exports = { notesToText, Updater, verifySignature, signedMessage, sha512File, RELEASE_KEY };
