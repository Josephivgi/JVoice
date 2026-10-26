'use strict';
// SQLite storage for settings, history and the personal dictionary.
const { DatabaseSync } = require('node:sqlite');

const DEFAULTS = {
  apiKeyEnc: '',
  hotkey: [29, 3675], // Ctrl + Win (uiohook keycodes)
  hotkeyMode: 'hold', // 'hold' | 'toggle'
  sttModel: 'elevenlabs/scribe-v2',
  language: '',
  micDeviceId: '',
  aiEnabled: true,
  aiModel: 'deepseek/deepseek-v4.1-flash',
  aiStyle: 'clean', // 'clean' | 'rewrite'
  aiCustomPrompt: '',
  outputMode: 'paste', // 'paste' | 'copy'
  charLimit: 0, // longest text to paste in characters; 0 = unlimited
  restoreClipboard: true,
  sounds: true,
  launchAtLogin: false,
  keepHistory: true,
  maxRecordSeconds: 600,
  closeHintShown: false,
  lastVersion: '', // the version that ran last, so the first start after an update can say what changed
  updateNotes: '', // notes of the update being installed, saved just before the restart

};

class Store {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        raw TEXT NOT NULL DEFAULT '',
        final TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        style TEXT NOT NULL DEFAULT '',
        stt_model TEXT NOT NULL DEFAULT '',
        ai_model TEXT NOT NULL DEFAULT '',
        duration_ms INTEGER NOT NULL DEFAULT 0,
        words INTEGER NOT NULL DEFAULT 0,
        cost REAL NOT NULL DEFAULT 0,
        audio_path TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS history_created ON history(created_at DESC);
      CREATE INDEX IF NOT EXISTS history_status_created ON history(status, created_at);
      CREATE TABLE IF NOT EXISTS dictionary (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        term TEXT NOT NULL UNIQUE COLLATE NOCASE,
        heard_as TEXT NOT NULL DEFAULT ''
      );
    `);
    // Added in 0.2.0: the length limit a dictation was cut to (0 = not cut).
    if (!this.db.prepare('PRAGMA table_info(history)').all().some((c) => c.name === 'cut')) {
      this.db.exec('ALTER TABLE history ADD COLUMN cut INTEGER NOT NULL DEFAULT 0');
    }
    this.q = {
      settings: this.db.prepare('SELECT key, value FROM settings'),
      setSetting: this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
      item: this.db.prepare('SELECT * FROM history WHERE id = ?'),
    };
    this.cache = null;
  }

  // Settings are read several times per dictation, so they are parsed once and kept until the next write.
  getSettings() {
    if (!this.cache) this.cache = this.readSettings();
    return { ...this.cache, hotkey: [...this.cache.hotkey] };
  }

  readSettings() {
    const out = { ...DEFAULTS };
    for (const row of this.q.settings.all()) {
      if (row.key in DEFAULTS) {
        try { out[row.key] = JSON.parse(row.value); } catch { /* keep default */ }
      }
    }
    // Earlier versions had 'intent' and 'custom' styles; both are now Rewrite.
    if (!['clean', 'rewrite'].includes(out.aiStyle)) out.aiStyle = 'rewrite';
    return out;
  }

  setSettings(patch) {
    for (const [k, v] of Object.entries(patch)) {
      if (k in DEFAULTS) this.q.setSetting.run(k, JSON.stringify(v));
    }
    this.cache = null;
    return this.getSettings();
  }

  addHistory(row) {
    const r = this.db.prepare(`INSERT INTO history
      (created_at, status, raw, final, error, style, stt_model, ai_model, duration_ms, words, cost, audio_path, cut)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      row.created_at ?? Date.now(), row.status, row.raw ?? '', row.final ?? '', row.error ?? '',
      row.style ?? '', row.stt_model ?? '', row.ai_model ?? '', row.duration_ms ?? 0,
      row.words ?? 0, row.cost ?? 0, row.audio_path ?? '', row.cut ?? 0);
    return this.getHistoryItem(Number(r.lastInsertRowid));
  }

  updateHistory(id, patch) {
    const allowed = ['status', 'raw', 'final', 'error', 'style', 'ai_model', 'words', 'cost', 'audio_path', 'cut'];
    const keys = Object.keys(patch).filter((k) => allowed.includes(k));
    if (!keys.length) return this.getHistoryItem(id);
    this.db.prepare(`UPDATE history SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map((k) => patch[k]), id);
    return this.getHistoryItem(id);
  }

  getHistoryItem(id) {
    return this.q.item.get(id) ?? null;
  }

  listHistory({ query = '', limit = 200 } = {}) {
    if (query) {
      const like = `%${query.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
      return this.db.prepare(`SELECT * FROM history WHERE final LIKE ? ESCAPE '\\' OR raw LIKE ? ESCAPE '\\'
        ORDER BY created_at DESC LIMIT ?`).all(like, like, limit);
    }
    return this.db.prepare('SELECT * FROM history ORDER BY created_at DESC LIMIT ?').all(limit);
  }

  deleteHistory(id) {
    const row = this.getHistoryItem(id);
    this.db.prepare('DELETE FROM history WHERE id = ?').run(id);
    return row;
  }

  clearHistory() {
    const rows = this.db.prepare("SELECT audio_path FROM history WHERE audio_path != ''").all();
    this.db.exec('DELETE FROM history');
    return rows.map((r) => r.audio_path);
  }

  stats() {
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const all = this.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(words),0) AS words, COALESCE(SUM(duration_ms),0) AS ms, COALESCE(SUM(cost),0) AS cost FROM history WHERE status = 'done'").get();
    const today = this.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(words),0) AS words FROM history WHERE status = 'done' AND created_at >= ?").get(dayStart.getTime());
    return {
      total: all.n, words: all.words, seconds: Math.round(all.ms / 1000), cost: all.cost,
      todayCount: today.n, todayWords: today.words,
      wpm: all.ms > 0 ? Math.round(all.words / (all.ms / 60000)) : 0,
    };
  }

  listDictionary() {
    return this.db.prepare('SELECT * FROM dictionary ORDER BY term COLLATE NOCASE').all();
  }

  saveDictionary({ id, term, heard_as }) {
    term = String(term ?? '').trim();
    heard_as = String(heard_as ?? '').trim();
    if (!term) throw new Error('Enter a word or phrase.');
    if (id) this.db.prepare('UPDATE dictionary SET term = ?, heard_as = ? WHERE id = ?').run(term, heard_as, id);
    else this.db.prepare('INSERT INTO dictionary (term, heard_as) VALUES (?, ?)').run(term, heard_as);
    return this.listDictionary();
  }

  deleteDictionary(id) {
    this.db.prepare('DELETE FROM dictionary WHERE id = ?').run(id);
    return this.listDictionary();
  }

  close() { this.db.close(); }
}

module.exports = { Store, DEFAULTS };
