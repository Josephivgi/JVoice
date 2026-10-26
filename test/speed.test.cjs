'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { speechCounts, rates, checkPiece, plannedSeconds } = require('../app/speed.cjs');
const { makeSegmenter, encodeWav } = require('../app/ui/audio.js');
const { Store } = require('../app/db.cjs');

test('speechCounts: words by word boundaries, characters are letters and numbers only', () => {
  assert.deepEqual(speechCounts("Hey, it's 5 o'clock. Ready?"), { words: 5, chars: 18 });
  assert.deepEqual(speechCounts('I don’t know, café 25%.'), { words: 5, chars: 15 });
  assert.deepEqual(speechCounts('   '), { words: 0, chars: 0 });
  // Written without spaces, still split into words.
  assert.ok(speechCounts('我们今天去公园散步。', 'zh').words >= 4);
  assert.equal(speechCounts('我们今天去公园散步。', 'zh').chars, 9);
  // An emoji is not a spoken letter; an accented letter is one character.
  assert.deepEqual(speechCounts('👍 é'), { words: 1, chars: 1 });
  // A bad language code falls back to the default rules.
  assert.deepEqual(speechCounts('one two', 'not a language!'), { words: 2, chars: 6 });
});

test('rates are per minute over the given seconds', () => {
  assert.deepEqual(rates({ words: 150, chars: 700, seconds: 60 }), { wpm: 150, cpm: 700 });
  assert.deepEqual(rates({ words: 75, chars: 350, seconds: 30 }), { wpm: 150, cpm: 700 });
  assert.deepEqual(rates({ words: 9000, chars: 42000, seconds: 3600 }), { wpm: 150, cpm: 700 });
  assert.deepEqual(rates({ words: 10, chars: 10, seconds: 0 }), { wpm: 0, cpm: 0 });
});

test('pieces must be small 16 kHz mono WAVs', () => {
  const { wav } = encodeWav([new Int16Array(16000)], 16000);
  assert.equal(checkPiece(wav), '');
  assert.match(checkPiece(new Uint8Array(10)), /size/);
  assert.match(checkPiece(encodeWav([new Int16Array(100)], 44100).wav), /16 kHz/);
  const notWav = new Uint8Array(wav); notWav[0] = 0;
  assert.match(checkPiece(notWav), /not a WAV/);
  assert.match(checkPiece(new Uint8Array(44 + 61 * 32000)), /size/);
  assert.match(checkPiece('RIFF'), /size/);
});

test('planned length: 0 is no limit, otherwise 10 seconds to 3 hours', () => {
  assert.equal(plannedSeconds(0), 0);
  assert.equal(plannedSeconds(-5), 0);
  assert.equal(plannedSeconds('abc'), 0);
  assert.equal(plannedSeconds(3), 10);
  assert.equal(plannedSeconds(3600), 3600);
  assert.equal(plannedSeconds(99999), 10800);
});

// 1024-sample chunks at 16 kHz, like the recorder sends: speech at level 0.2, pauses at 0.001.
function feed(seg, pattern) {
  const pieces = [];
  for (const [sec, level] of pattern) {
    for (let n = Math.round((sec * 16000) / 1024); n > 0; n--) {
      const p = seg.push(new Int16Array(1024), level, level * 1.4);
      if (p) pieces.push(p);
    }
  }
  const last = seg.flush();
  if (last) pieces.push(last);
  return pieces.map((p) => p.samples / 16000);
}

test('segmenter cuts in a pause after 8 seconds, never past 20, and keeps every sample', () => {
  // Talking 9 s, pause 1 s, talking 5 s: one cut in the pause.
  const a = feed(makeSegmenter(), [[9, 0.2], [1, 0.001], [5, 0.2]]);
  assert.equal(a.length, 2);
  assert.ok(a[0] >= 9 && a[0] <= 9.5, `cut at ${a[0]}`);
  // A pause before 8 seconds does not cut.
  assert.equal(feed(makeSegmenter(), [[4, 0.2], [1, 0.001], [2, 0.2]]).length, 1);
  // Non-stop talking is cut at 20 seconds.
  const c = feed(makeSegmenter(), [[45, 0.2]]);
  assert.ok(c.slice(0, -1).every((s) => s >= 19.9 && s <= 20.1), c.join(','));
  const total = c.reduce((x, y) => x + y, 0);
  assert.equal(total, (Math.round((45 * 16000) / 1024) * 1024) / 16000);
  // Quiet speakers: the pause level follows their speaking level.
  const d = feed(makeSegmenter(), [[9, 0.03], [1, 0.002], [3, 0.03]]);
  assert.equal(d.length, 2);
});

test('store: speed test results are saved, listed newest first and deleted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jvoice-speed-'));
  const store = new Store(path.join(dir, 'test.db'));
  try {
    const a = store.addSpeedTest({ created_at: 1000, planned_seconds: 60, seconds: 60, words: 150, chars: 700, wpm: 150, cpm: 700, transcript: 'hello' });
    store.addSpeedTest({ created_at: 2000, planned_seconds: 0, seconds: 30, words: 70, chars: 300, wpm: 140, cpm: 600, transcript: 'world' });
    assert.equal(a.wpm, 150);
    assert.deepEqual(store.listSpeedTests().map((r) => r.created_at), [2000, 1000]);
    store.deleteSpeedTest(a.id);
    assert.deepEqual(store.listSpeedTests().map((r) => r.transcript), ['world']);
    assert.equal(store.getSettings().speedLength, 60);
    assert.equal(store.setSettings({ speedLength: 0 }).speedLength, 0);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
