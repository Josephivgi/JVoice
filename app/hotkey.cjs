'use strict';
// Global key combo detection with a low-level keyboard hook (works for modifier-only combos like Ctrl + Win).
const { EventEmitter } = require('node:events');
const { uIOhook, UiohookKey } = require('uiohook-napi');

const K = UiohookKey;
const RIGHT_TO_LEFT = { [K.CtrlRight]: K.Ctrl, [K.ShiftRight]: K.Shift, [K.AltRight]: K.Alt, [K.MetaRight]: K.Meta };
const MODIFIERS = new Set([K.Ctrl, K.Shift, K.Alt, K.Meta]);
const MOD_ORDER = [K.Ctrl, K.Meta, K.Alt, K.Shift];
// Windows virtual key codes for each physical modifier, used to check the real key state.
const VK = { [K.Ctrl]: 0xA2, [K.CtrlRight]: 0xA3, [K.Shift]: 0xA0, [K.ShiftRight]: 0xA1, [K.Alt]: 0xA4, [K.AltRight]: 0xA5, [K.Meta]: 0x5B, [K.MetaRight]: 0x5C };
// Hook event flag for each modifier, used to drop key-down entries whose key-up was missed.
const FLAG = { [K.Ctrl]: 'ctrlKey', [K.Shift]: 'shiftKey', [K.Alt]: 'altKey', [K.Meta]: 'metaKey' };

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

// Windows shortcuts a dictation combo must never be: holding them would trigger Windows instead.
const RESERVED = [
  { keys: [K.Ctrl, K.Meta, K.F24], why: 'Windows uses Ctrl + Win + F24 to turn the touchpad on and off.' },
  { keys: [K.Meta, K.Shift, K.F23], why: 'Windows uses Win + Shift + F23 for the Copilot key.' },
  { keys: [K.Meta, K.L], why: 'Win + L locks Windows.' },
];

// A combo needs at least two keys, or one non-modifier function key (F13 and up are free on most keyboards).
function validateCombo(codes) {
  const c = sortCombo(codes);
  if (!c.length) return 'Press a key combination.';
  for (const r of RESERVED) if (r.keys.every((k) => c.includes(k)) && c.length === r.keys.length) return r.why;
  if (c.includes(K.Escape)) return 'Esc is used to cancel a recording. Pick another combo.';
  if (c.length === 1 && MODIFIERS.has(c[0])) return 'A single modifier key would trigger all the time. Add a second key.';
  if (c.length === 1 && !(c[0] >= K.F13 && c[0] <= K.F24)) return 'Use at least two keys, for example Ctrl + Win.';
  if (c.length > 4) return 'Use four keys or fewer.';
  return null;
}

function defaultKeyState() {
  try { return require('./win32.cjs').isKeyDown; } catch { return null; }
}

// Windows virtual keys used for the keys JVoice sends.
const VK_CONTROL = 0x11, VK_V = 0x56;
// 0xE8 is unassigned in Windows. Tapping it while Win is held stops Start from opening when Win is
// released, without triggering anything (AutoHotkey uses the same key). Never use F24 for this:
// Ctrl + Win + F24 is the Windows touchpad on/off shortcut.
const VK_MASK = 0xE8;

class Hotkey extends EventEmitter {
  // send: ([{ vk, up }]) => void, sends keys to Windows. Null (the default, and in tests) sends nothing.
  constructor({ isKeyDown = defaultKeyState(), send = null } = {}) {
    super();
    this.isKeyDown = isKeyDown; // (vk) => boolean, or null when unavailable
    this.send = send;
    this.combo = [K.Ctrl, K.Meta];
    this.mode = 'hold';
    this.raw = new Map(); // physical keycode -> last keydown time
    this.active = false; // combo fully held right now
    this.recording = false; // app is busy (recording or processing); Esc cancels
    this.paused = false;
    this.injected = []; // our own synthetic events still to arrive: { type, code, until }
    this.capture = null; // callback while the user records a new combo in Settings
    this.started = false;
  }

  configure({ combo, mode }) {
    if (combo) this.combo = sortCombo(combo);
    if (mode) this.mode = mode;
    this.active = false;
  }

  start() {
    if (this.started) return;
    uIOhook.on('keydown', (e) => this.onDown(e.keycode, e));
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

  reset() { this.raw.clear(); this.active = false; }

  held() { return new Set([...this.raw.keys()].map(norm)); }
  comboHeld(held = this.held()) { return this.combo.every((c) => held.has(c)); }

  // Skip events we injected ourselves, matched one by one, so real keys are never swallowed.
  consumeInjected(type, code) {
    if (!this.injected.length) return false; // the usual case: runs for every key the user types
    const now = Date.now();
    this.injected = this.injected.filter((e) => e.until > now);
    const i = this.injected.findIndex((e) => e.type === type && norm(e.code) === norm(code));
    if (i < 0) return false;
    this.injected.splice(i, 1);
    return true;
  }

  // Forget keys whose key-up we never saw (lock screen, UAC prompt, focus change to an elevated app).
  // ev is the hook event; its modifier flags are the state when this key was pressed, so queued events
  // are judged by their own moment, not by the live keyboard. Flags only ever remove entries, so a stale
  // flag after the lock screen does no harm (the lock-screen handler also resets everything). Without
  // flags, old modifier entries are checked against the live key state.
  reconcile(now, except, ev) {
    for (const [c, t] of this.raw) {
      if (c === except) continue;
      const f = FLAG[norm(c)];
      if (f && ev && typeof ev[f] === 'boolean') {
        if (!ev[f]) this.raw.delete(c); // the event says it was up: our key-down entry is stale
      } else if (VK[c] && this.isKeyDown) {
        if (now - t > 1000 && !this.isKeyDown(VK[c])) this.raw.delete(c);
      } else if (now - t > 8000) this.raw.delete(c); // non-modifier keys auto-repeat while held
    }
  }

  onDown(code, ev) {
    if (!code) return; // keycode 0: keys with no meaning to the hook, such as our own VK_MASK tap
    if (this.consumeInjected('down', code)) return;
    const now = Date.now();
    this.reconcile(now, code, ev);
    const repeat = this.raw.has(code);
    this.raw.set(code, now);
    if (repeat) return; // auto-repeat while a key is held
    const n = norm(code);
    const held = this.held();
    if (this.capture) { this.capture('down', n, [...held]); return; }
    if (n === K.Escape && this.recording) { this.emit('cancel'); return; }
    if (this.paused) return;

    if (!this.active && this.comboHeld(held) && held.size === this.combo.length) {
      this.active = true;
      if (this.combo.includes(K.Meta)) this.maskStart();
      if (this.mode === 'toggle') this.emit(this.recording ? 'stop' : 'start');
      else this.emit('start');
    } else if (this.active && !this.combo.includes(n) && this.mode === 'hold') {
      // An extra key while holding means the user meant a different shortcut (Ctrl + Win + D, ...).
      this.emit('interrupt');
    }
  }

  onUp(code) {
    if (!code) return;
    if (this.consumeInjected('up', code)) return;
    this.raw.delete(code);
    const held = this.held();
    if (this.capture) { this.capture('up', norm(code), [...held]); return; }
    if (this.active && !this.comboHeld(held)) {
      this.active = false;
      if (this.mode === 'hold' && this.recording) this.emit('stop');
    }
  }

  // Keeps Start closed when the user lets go of Win (see VK_MASK).
  maskStart() {
    if (this.send) this.send([{ vk: VK_MASK }, { vk: VK_MASK, up: true }]);
  }

  modifiersDown() {
    if (this.isKeyDown) return Object.values(VK).some((vk) => this.isKeyDown(vk));
    return [...this.held()].some((c) => MODIFIERS.has(c));
  }

  // Waits until the user lets go of modifier keys so a synthetic Ctrl+V is not read as Ctrl+Win+V.
  // Returns false if they are still held at the timeout, or if the signal aborts.
  async waitForModifiersReleased(timeoutMs = 1500, signal) {
    const end = Date.now() + timeoutMs;
    while (this.modifiersDown()) {
      if (signal?.aborted || Date.now() >= end) return false;
      await new Promise((r) => setTimeout(r, 25));
    }
    return !signal?.aborted;
  }

  // Ctrl+V as one SendInput batch, so the user's own key presses cannot land in the middle of it.
  paste() {
    if (!this.send) return;
    const until = Date.now() + 1000;
    for (const c of [K.Ctrl, K.V]) this.injected.push({ type: 'down', code: c, until }, { type: 'up', code: c, until });
    this.send([{ vk: VK_CONTROL }, { vk: VK_V }, { vk: VK_V, up: true }, { vk: VK_CONTROL, up: true }]);
  }
}

module.exports = { Hotkey, comboLabel, validateCombo, sortCombo, keyName, K };
