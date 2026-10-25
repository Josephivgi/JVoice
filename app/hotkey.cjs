'use strict';
// Global key combo detection with a low-level keyboard hook (works for modifier-only combos like Ctrl + Win).
const { EventEmitter } = require('node:events');
const { uIOhook, UiohookKey } = require('uiohook-napi');

const K = UiohookKey;
const RIGHT_TO_LEFT = { [K.CtrlRight]: K.Ctrl, [K.ShiftRight]: K.Shift, [K.AltRight]: K.Alt, [K.MetaRight]: K.Meta };
const MODIFIERS = new Set([K.Ctrl, K.Shift, K.Alt, K.Meta]);
const MOD_ORDER = [K.Ctrl, K.Meta, K.Alt, K.Shift];

const NAMES = {};
for (const [name, code] of Object.entries(K)) if (!(code in NAMES)) NAMES[code] = name;
Object.assign(NAMES, { [K.Ctrl]: 'Ctrl', [K.Shift]: 'Shift', [K.Alt]: 'Alt', [K.Meta]: 'Win', [K.Space]: 'Space', [K.Escape]: 'Esc' });

const norm = (code) => RIGHT_TO_LEFT[code] ?? code;
const keyName = (code) => NAMES[code] ?? `Key ${code}`;
const sortCombo = (codes) => [...new Set(codes.map(norm))].sort((a, b) => {
  const ia = MOD_ORDER.indexOf(a), ib = MOD_ORDER.indexOf(b);
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a - b;
});
const comboLabel = (codes) => sortCombo(codes).map(keyName);

// A combo needs at least two keys, or one non-modifier function key (F13 and up are free on most keyboards).
function validateCombo(codes) {
  const c = sortCombo(codes);
  if (!c.length) return 'Press a key combination.';
  if (c.includes(K.Escape)) return 'Esc is used to cancel a recording. Pick another combo.';
  if (c.length === 1 && MODIFIERS.has(c[0])) return 'A single modifier key would trigger all the time. Add a second key.';
  if (c.length === 1 && !(c[0] >= K.F13 && c[0] <= K.F24)) return 'Use at least two keys, for example Ctrl + Win.';
  if (c.length > 4) return 'Use four keys or fewer.';
  return null;
}

class Hotkey extends EventEmitter {
  constructor() {
    super();
    this.combo = [K.Ctrl, K.Meta];
    this.mode = 'hold';
    this.down = new Set();
    this.seen = new Map(); // keycode -> last keydown time
    this.active = false; // combo fully held right now
    this.recording = false; // set by the app
    this.paused = false;
    this.suppressUntil = 0; // ignore our own synthetic keys
    this.capture = null; // callback while the user is recording a new combo in Settings
    this.started = false;
  }

  configure({ combo, mode }) {
    if (combo) this.combo = sortCombo(combo);
    if (mode) this.mode = mode;
    this.active = false;
  }

  start() {
    if (this.started) return;
    uIOhook.on('keydown', (e) => this.onDown(e.keycode));
    uIOhook.on('keyup', (e) => this.onUp(e.keycode));
    uIOhook.start();
    this.started = true;
  }

  stop() {
    if (!this.started) return;
    uIOhook.removeAllListeners();
    uIOhook.stop();
    this.started = false;
  }

  reset() { this.down.clear(); this.seen.clear(); this.active = false; }

  comboHeld() { return this.combo.every((c) => this.down.has(c)); }

  onDown(raw) {
    const code = norm(raw);
    const now = Date.now();
    // Drop keys whose key-up we never saw (lock screen, UAC prompt). Held keys auto-repeat, so they stay fresh.
    for (const [c, t] of this.seen) if (now - t > 8000 && c !== code) { this.down.delete(c); this.seen.delete(c); }
    const repeat = this.down.has(code);
    this.down.add(code);
    this.seen.set(code, now);
    if (Date.now() < this.suppressUntil) return;
    if (this.capture) { if (!repeat) this.capture('down', code, [...this.down]); return; }
    if (repeat) return;
    if (code === K.Escape && this.recording) { this.emit('cancel'); return; }
    if (this.paused) return;

    if (!this.active && this.comboHeld() && this.down.size === this.combo.length) {
      this.active = true;
      // Tapping a dead key while Win is down stops Windows from opening Start when Win is released.
      if (this.combo.includes(K.Meta)) this.tap(K.F24);
      if (this.mode === 'toggle') this.emit(this.recording ? 'stop' : 'start');
      else this.emit('start');
    } else if (this.active && !this.combo.includes(code) && this.mode === 'hold') {
      // An extra key while holding means the user meant a different shortcut (Ctrl + Win + D, ...).
      this.emit('interrupt');
    }
  }

  onUp(raw) {
    const code = norm(raw);
    this.down.delete(code);
    this.seen.delete(code);
    if (this.capture) { this.capture('up', code, [...this.down]); return; }
    if (this.active && this.combo.includes(code)) {
      this.active = false;
      if (this.mode === 'hold' && this.recording) this.emit('stop');
    }
  }

  tap(code, modifiers = []) {
    this.suppressUntil = Date.now() + 250;
    uIOhook.keyTap(code, modifiers);
  }

  // Wait until the user lets go of modifier keys so a synthetic Ctrl+V is not read as Ctrl+Win+V.
  async waitForModifiersReleased(timeoutMs = 1500) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end && [...this.down].some((c) => MODIFIERS.has(c))) await new Promise((r) => setTimeout(r, 25));
  }

  paste() { this.tap(K.V, [K.Ctrl]); }
}

module.exports = { Hotkey, comboLabel, validateCombo, sortCombo, keyName, K };
