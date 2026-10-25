'use strict';
// Updates from GitHub Releases (Josephivgi/JVoice). Checks at startup and every few hours, downloads in
// the background, then restarts JVoice into the new version as soon as no dictation is running.
const { EventEmitter } = require('node:events');

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 15 * 1000;
const RESTART_COUNTDOWN_MS = 5 * 1000;

class Updater extends EventEmitter {
  // isBusy: () => boolean, true while the user is dictating (the restart waits for idle).
  constructor({ app, isBusy, log = console }) {
    super();
    this.app = app;
    this.isBusy = isBusy;
    this.log = log;
    this.state = { status: app.isPackaged ? 'idle' : 'dev', version: app.getVersion() };
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
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.logger = null;

    autoUpdater.on('checking-for-update', () => this.setState({ status: 'checking', error: '' }));
    autoUpdater.on('update-not-available', () => this.setState({ status: 'current', checkedAt: Date.now() }));
    autoUpdater.on('update-available', (info) => this.setState({ status: 'downloading', next: info.version, percent: 0 }));
    autoUpdater.on('download-progress', (p) => this.setState({ status: 'downloading', percent: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded', (info) => {
      this.setState({ status: 'ready', next: info.version, percent: 100 });
      this.restartWhenIdle();
    });
    autoUpdater.on('error', (err) => {
      this.log.error('update error', err?.message);
      this.setState({ status: 'error', error: friendly(err) });
    });

    setTimeout(() => this.check(), FIRST_CHECK_DELAY_MS);
    this.timer = setInterval(() => this.check(), CHECK_EVERY_MS);
  }

  async check() {
    if (!this.autoUpdater) return this.state;
    if (['checking', 'downloading', 'ready', 'restarting'].includes(this.state.status)) return this.state;
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
      this.emit('before-restart');
      // Silent install, then start the new version.
      this.autoUpdater.quitAndInstall(true, true);
    }, RESTART_COUNTDOWN_MS);
  }

  restartNow() {
    if (this.state.status !== 'ready' && this.state.status !== 'restarting') return false;
    clearTimeout(this.restartTimer);
    this.emit('before-restart');
    this.autoUpdater.quitAndInstall(true, true);
    return true;
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

module.exports = { Updater };
