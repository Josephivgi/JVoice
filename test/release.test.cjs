'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { sanitizeOutput, forTerminal, isTerminal, oneLine, improveTimeout } = require('../app/openrouter.cjs');
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
  assert.equal(sanitizeOutput('a\u0007b\u001b[31mc\r\nd\u202Ee\u2066f\tg'), 'ab[31mc\nde' + 'f\tg');
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

test('joiners and direction marks survive, and terminals lose direction marks', () => {
  const persian = 'm\u200Cx \uD83D\uDC68\u200D\uD83D\uDC69 a\u200Fb';
  assert.equal(sanitizeOutput(persian), persian);
  assert.equal(forTerminal('a\u200Eb\u200Fc'), 'abc');
});

test('line separators become new lines, invisible marks go, and console windows count as terminals', () => {
  assert.equal(sanitizeOutput('a\u2028b\u200Bc\u061Cd'), 'a\nbcd');
  assert.equal(oneLine('a\u2029b'), 'a b');
  assert.ok(isTerminal('ssh.exe', 'ConsoleWindowClass') && isTerminal('python.exe', 'CASCADIA_HOSTING_WINDOW_CLASS') && !isTerminal('code.exe', 'Chrome_WidgetWin_1'));
});

test('release notes from GitHub become plain lines', () => {
  const { notesToText } = require('../app/updater.cjs');
  const html = '<p><strong>New</strong></p>\n<ul>\n<li>Settings &gt; Model lists <code>DeepSeek</code> &amp; more.</li>\n<li>Two</li>\n</ul>';
  assert.equal(notesToText(html), 'New\n- Settings > Model lists DeepSeek & more.\n- Two');
  assert.equal(notesToText(null), '');
});
