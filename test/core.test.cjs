'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { applyDictionary, countWords, buildSystemPrompt } = require('../app/openrouter.cjs');
const { Hotkey, validateCombo, comboLabel, K } = require('../app/hotkey.cjs');
const { Store } = require('../app/db.cjs');

test('dictionary replaces heard-as spellings on whole words only', () => {
  const dict = [{ term: 'JVoice', heard_as: 'jay voice, j voice' }, { term: 'Kubernetes', heard_as: 'cooper netties' }];
  assert.equal(applyDictionary('Open Jay Voice and j voice, then Cooper Netties.', dict), 'Open JVoice and JVoice, then Kubernetes.');
  assert.equal(applyDictionary('majay voiceless', dict), 'majay voiceless');
  assert.equal(applyDictionary('cost is $5 (j voice)', [{ term: 'X', heard_as: '$5' }, ...dict]), 'cost is X (JVoice)');
});

test('countWords handles punctuation and contractions', () => {
  assert.equal(countWords("Hey, it's 5 o'clock. Ready?"), 5);
  assert.equal(countWords('   '), 0);
});

test('system prompt carries style, custom text and terms', () => {
  const p = buildSystemPrompt({ style: 'custom', customPrompt: 'Write as an email.', terms: ['JVoice'] });
  assert.match(p, /Follow these instructions from the user:\nWrite as an email\./);
  assert.match(p, /JVoice/);
  assert.match(buildSystemPrompt({ style: 'intent', customPrompt: '', terms: [] }), /said what the speaker meant|says what the speaker meant/);
});

test('combo validation', () => {
  assert.equal(validateCombo([K.Ctrl, K.Meta]), null);
  assert.ok(validateCombo([K.Ctrl]));
  assert.ok(validateCombo([K.A]));
  assert.equal(validateCombo([K.F13]), null);
  assert.ok(validateCombo([K.Ctrl, K.Escape]));
  assert.deepEqual(comboLabel([K.MetaRight, K.CtrlRight]), ['Ctrl', 'Win']);
});

test('hold mode: start on full combo, stop on release, interrupt on extra key', () => {
  const h = new Hotkey({ isKeyDown: null });
  h.tap = () => {}; // no real key injection in tests
  h.configure({ combo: [K.Ctrl, K.Meta], mode: 'hold' });
  const ev = [];
  for (const e of ['start', 'stop', 'interrupt', 'cancel']) h.on(e, () => { ev.push(e); if (e === 'start') h.recording = true; if (e === 'stop') h.recording = false; });
  h.onDown(K.Ctrl); h.onDown(K.Meta); h.onDown(K.Meta); // repeat is ignored
  h.onUp(K.Meta); h.onUp(K.Ctrl);
  h.onDown(K.Ctrl); h.onDown(K.Meta); h.onDown(K.D);
  assert.deepEqual(ev, ['start', 'stop', 'start', 'interrupt']);
  h.onUp(K.D); h.onDown(K.Escape);
  assert.equal(ev.at(-1), 'cancel');
});

test('hold mode ignores the combo when other keys are already held', () => {
  const h = new Hotkey({ isKeyDown: null }); h.tap = () => {};
  h.configure({ combo: [K.Ctrl, K.Meta], mode: 'hold' });
  let started = 0; h.on('start', () => started++);
  h.onDown(K.Shift); h.onDown(K.Ctrl); h.onDown(K.Meta);
  assert.equal(started, 0);
});

test('toggle mode: press to start, press again to stop', () => {
  const h = new Hotkey({ isKeyDown: null }); h.tap = () => {};
  h.configure({ combo: [K.Ctrl, K.Shift, K.Space], mode: 'toggle' });
  const ev = [];
  h.on('start', () => { ev.push('start'); h.recording = true; });
  h.on('stop', () => { ev.push('stop'); h.recording = false; });
  const press = () => { h.onDown(K.Ctrl); h.onDown(K.Shift); h.onDown(K.Space); h.onUp(K.Space); h.onUp(K.Shift); h.onUp(K.Ctrl); };
  press(); press();
  assert.deepEqual(ev, ['start', 'stop']);
});

test('store: settings, history, stats and dictionary', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jvoice-test-'));
  const s = new Store(path.join(dir, 'db.sqlite'));
  assert.equal(s.getSettings().hotkeyMode, 'hold');
  s.setSettings({ hotkeyMode: 'toggle', bogus: 1 });
  assert.equal(s.getSettings().hotkeyMode, 'toggle');
  assert.equal(s.getSettings().bogus, undefined);
  const row = s.addHistory({ status: 'done', raw: 'um hello', final: 'Hello.', words: 1, duration_ms: 3000, cost: 0.001 });
  s.addHistory({ status: 'failed', error: 'x', audio_path: 'a.wav' });
  assert.equal(s.listHistory({ query: 'hello' }).length, 1);
  assert.equal(s.listHistory({ query: '100%' }).length, 0);
  assert.equal(s.stats().words, 1);
  assert.equal(s.stats().wpm, 20);
  s.saveDictionary({ term: 'JVoice', heard_as: 'jay voice' });
  assert.throws(() => s.saveDictionary({ term: 'jvoice' }), /UNIQUE/);
  assert.deepEqual(s.clearHistory(), ['a.wav']);
  assert.equal(s.getHistoryItem(row.id), null);
  s.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('dictionary terms are inserted literally', () => {
  assert.equal(applyDictionary('pay j voice', [{ term: 'J$&V', heard_as: 'j voice' }]), 'pay J$&V');
});

test('our own injected keys are skipped, real keys are not', () => {
  const h = new Hotkey({ isKeyDown: null });
  h.configure({ combo: [K.Ctrl, K.Meta], mode: 'hold' });
  const ev = [];
  h.on('start', () => { ev.push('start'); h.recording = true; });
  h.on('interrupt', () => ev.push('interrupt'));
  h.on('cancel', () => ev.push('cancel'));
  h.injected.push({ type: 'down', code: K.F24, until: Date.now() + 1000 }, { type: 'up', code: K.F24, until: Date.now() + 1000 });
  h.tap = () => {};
  h.onDown(K.Ctrl); h.onDown(K.Meta);
  h.onDown(K.F24); h.onUp(K.F24); // injected: ignored
  h.onDown(K.D); // real: interrupts right away
  h.onDown(K.Escape);
  assert.deepEqual(ev, ['start', 'interrupt', 'cancel']);
});

test('releasing one of two held Ctrl keys keeps recording', () => {
  const h = new Hotkey({ isKeyDown: null }); h.tap = () => {};
  h.configure({ combo: [K.Ctrl, K.Meta], mode: 'hold' });
  const ev = [];
  h.on('start', () => { ev.push('start'); h.recording = true; });
  h.on('stop', () => ev.push('stop'));
  h.onDown(K.Ctrl); h.onDown(K.Meta); h.onDown(K.CtrlRight);
  h.onUp(K.CtrlRight);
  assert.deepEqual(ev, ['start']);
  h.onUp(K.Ctrl);
  assert.deepEqual(ev, ['start', 'stop']);
});

test('modifiers whose key-up was missed are dropped using the real key state', () => {
  const physical = new Set([0x5B]); // only Win is really down
  const h = new Hotkey({ isKeyDown: (vk) => physical.has(vk) }); h.tap = () => {};
  h.configure({ combo: [K.Meta, K.Space], mode: 'hold' });
  let started = 0; h.on('start', () => started++);
  h.raw.set(K.Shift, Date.now() - 5000); // stale: Windows says Shift is up
  h.onDown(K.Meta); h.onDown(K.Space);
  assert.equal(started, 1);
});

test('waitForModifiersReleased reports a timeout', async () => {
  const h = new Hotkey({ isKeyDown: (vk) => vk === 0xA2 });
  assert.equal(await h.waitForModifiersReleased(60), false);
  const free = new Hotkey({ isKeyDown: () => false });
  assert.equal(await free.waitForModifiersReleased(60), true);
});

test('a just-pressed modifier is trusted even if Windows already reports it released (queued events)', () => {
  const h = new Hotkey({ isKeyDown: () => false }); h.tap = () => {};
  h.configure({ combo: [K.Ctrl, K.Meta], mode: 'toggle' });
  let started = 0; h.on('start', () => started++);
  h.onDown(K.Ctrl); h.onDown(K.Meta); // both handled late, after the user already let go
  assert.equal(started, 1);
});
