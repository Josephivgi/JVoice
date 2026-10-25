'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { sanitizeOutput, isTerminal, oneLine, improveTimeout } = require('../app/openrouter.cjs');
const { verifySignature, signedMessage, sha512File } = require('../app/updater.cjs');
const { Store } = require('../app/db.cjs');

test('update signatures: only the release key, version and file it was made for pass', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const msg = { version: '0.3.0', file: 'JVoice-Setup-0.3.0.exe', sha512: 'abc==' };
  const signature = crypto.sign(null, signedMessage(msg), privateKey).toString('base64');
  assert.equal(verifySignature({ ...msg, signature, publicKey }), true);
  assert.equal(verifySignature({ ...msg, version: '0.2.0', signature, publicKey }), false, 'replayed for another version');
  assert.equal(verifySignature({ ...msg, sha512: 'xyz==', signature, publicKey }), false, 'different installer');
  assert.equal(verifySignature({ ...msg, signature: 'bad', publicKey }), false);
  assert.equal(verifySignature({ ...msg, signature }), false, 'a random key is not the JVoice release key');
});

test('update file hash is the base64 sha512 that latest.yml uses', async () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jv-')), 'a.bin');
  fs.writeFileSync(f, 'hello');
  assert.equal(await sha512File(f), crypto.createHash('sha512').update('hello').digest('base64'));
});

test('pasted text loses control characters and hidden bidi overrides', () => {
  assert.equal(sanitizeOutput('a\u0007b\u001b[31mc\r\nd‮e⁦f\tg'), 'ab[31mc\nde' + 'f\tg');
});

test('text for a terminal becomes one line', () => {
  assert.ok(isTerminal('WindowsTerminal.exe') && isTerminal('pwsh.exe') && !isTerminal('notepad.exe') && !isTerminal(''));
  assert.equal(oneLine('ls\n\nrm -rf x\n'), 'ls rm -rf x');
});

test('cleanup timeout grows with the text and stays bounded', () => {
  assert.equal(improveTimeout('hi'), 10016);
  assert.ok(improveTimeout('x'.repeat(100000)) === 60000);
});

test('settings cache is cleared on write and callers cannot change it', () => {
  const s = new Store(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jv-')), 'db.sqlite'));
  const a = s.getSettings();
  a.hotkey.push(1); a.aiModel = 'x';
  assert.notEqual(s.getSettings().aiModel, 'x');
  assert.equal(s.getSettings().hotkey.length, 2);
  s.setSettings({ charLimit: 280 });
  assert.equal(s.getSettings().charLimit, 280);
  const row = s.addHistory({ status: 'done', style: 'clean', final: 'x' });
  assert.equal(s.updateHistory(row.id, { style: 'raw' }).style, 'raw');
  assert.equal(s.listHistory({ limit: 1 }).length, 1);
  s.close();
});
