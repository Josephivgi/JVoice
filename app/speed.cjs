'use strict';
// Speaking speed test: counts the words and characters in what Scribe heard and turns them into
// words and characters per minute. Plain counting, no language model.

const segmenters = new Map();
function segmenter(language, granularity) {
  const k = `${language}|${granularity}`;
  if (!segmenters.has(k)) {
    let s;
    try { s = new Intl.Segmenter(language || undefined, { granularity }); } catch { s = new Intl.Segmenter(undefined, { granularity }); }
    segmenters.set(k, s);
  }
  return segmenters.get(k);
}

// Words: Unicode word boundaries, so "don't" is one word and Chinese or Japanese, written without
// spaces, is still split into words. Characters: letters and numbers only, counted as the user sees
// them (an accented letter or emoji is one). Spaces and the punctuation Scribe adds are not spoken,
// so they are not counted.
function speechCounts(text, language = '') {
  const t = String(text ?? '');
  let words = 0, chars = 0;
  for (const s of segmenter(language, 'word').segment(t)) if (s.isWordLike) words++;
  for (const s of segmenter(language, 'grapheme').segment(t)) if (/[\p{L}\p{N}]/u.test(s.segment)) chars++;
  return { words, chars };
}

// Per minute rates over `seconds` of speaking time, rounded to whole numbers.
function rates({ words, chars, seconds }) {
  if (!(seconds > 0)) return { wpm: 0, cpm: 0 };
  return { wpm: Math.round(words / (seconds / 60)), cpm: Math.round(chars / (seconds / 60)) };
}

// A speed test piece is a 16 kHz mono 16-bit WAV of at most a minute (the page sends 8 to 20 seconds).
const MAX_PIECE_BYTES = 44 + 60 * 16000 * 2;
function checkPiece(wav) {
  if (!(wav instanceof Uint8Array) || wav.byteLength < 44 || wav.byteLength > MAX_PIECE_BYTES) return 'The recording piece has a bad size.';
  const b = Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength);
  if (b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WAVE') return 'The recording piece is not a WAV file.';
  if (b.readUInt16LE(22) !== 1 || b.readUInt32LE(24) !== 16000 || b.readUInt16LE(34) !== 16) return 'The recording piece is not 16 kHz mono audio.';
  return '';
}

// Planned length of a test in seconds: 0 means no limit (until the user stops), otherwise 10 s to 3 hours.
const MAX_TEST_SECONDS = 3 * 60 * 60;
const plannedSeconds = (v) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_TEST_SECONDS, Math.max(10, n));
};

module.exports = { speechCounts, rates, checkPiece, plannedSeconds, MAX_TEST_SECONDS };
