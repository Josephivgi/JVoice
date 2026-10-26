'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = new Set([
  'settings:get', 'settings:set', 'key:set', 'key:clear', 'key:info', 'models:list',
  'history:list', 'history:delete', 'history:clear', 'history:retry', 'clipboard:write', 'stats',
  'dict:list', 'dict:save', 'dict:delete', 'hotkey:capture', 'dictation:toggle', 'status',
  'app:info', 'open:external', 'open:mic-settings', 'issue:dismiss',
  'update:state', 'update:check', 'update:restart',
  'speed:active', 'speed:transcribe', 'speed:save', 'speed:list', 'speed:delete',
]);
const EVENTS = new Set(['nav', 'status', 'update', 'dictation:done', 'history:changed', 'hotkey:capture', 'overlay:state', 'rec:start', 'rec:stop', 'rec:cancel']);
const SEND = new Set(['rec:done', 'rec:error', 'rec:limit']);

contextBridge.exposeInMainWorld('jvoice', {
  // Resolves with data or throws an Error carrying the main process message.
  async invoke(channel, ...args) {
    if (!INVOKE.has(channel)) throw new Error(`Unknown channel ${channel}`);
    const r = await ipcRenderer.invoke(channel, ...args);
    if (!r.ok) throw new Error(r.error);
    return r.data;
  },
  on(channel, fn) {
    if (!EVENTS.has(channel)) throw new Error(`Unknown event ${channel}`);
    const listener = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  send(channel, payload) {
    if (SEND.has(channel)) ipcRenderer.send(channel, payload);
  },
});
