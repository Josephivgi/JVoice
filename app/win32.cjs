'use strict';
// Win32 helpers through koffi: foreground window, physical key state, and a full clipboard snapshot.
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');

const GetForegroundWindow = user32.func('void* __stdcall GetForegroundWindow()');
const GetClassNameW = user32.func('int __stdcall GetClassNameW(void*, _Out_ uint16*, int)');
const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(void*, _Out_ uint32*)');
const GetAsyncKeyState = user32.func('short __stdcall GetAsyncKeyState(int)');
const KEYBDINPUT = koffi.struct('KEYBDINPUT', { wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t' });
const MOUSEINPUT = koffi.struct('MOUSEINPUT', { dx: 'int32', dy: 'int32', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t' });
const INPUT = koffi.struct('INPUT', { type: 'uint32', u: koffi.union('INPUT_U', { mi: MOUSEINPUT, ki: KEYBDINPUT }) });
const SendInput = user32.func('uint32 __stdcall SendInput(uint32, const INPUT *, int)');
const MapVirtualKeyW = user32.func('uint32 __stdcall MapVirtualKeyW(uint32, uint32)');
const OpenClipboard = user32.func('int __stdcall OpenClipboard(intptr_t)');
const CloseClipboard = user32.func('int __stdcall CloseClipboard()');
const EmptyClipboard = user32.func('int __stdcall EmptyClipboard()');
const EnumClipboardFormats = user32.func('uint32 __stdcall EnumClipboardFormats(uint32)');
const GetClipboardData = user32.func('void* __stdcall GetClipboardData(uint32)');
const SetClipboardData = user32.func('void* __stdcall SetClipboardData(uint32, void*)');
const GetClipboardSequenceNumber = user32.func('uint32 __stdcall GetClipboardSequenceNumber()');
const IsClipboardFormatAvailable = user32.func('int __stdcall IsClipboardFormatAvailable(uint32)');
const RegisterClipboardFormatW = user32.func('uint32 __stdcall RegisterClipboardFormatW(str16)');
const OpenProcess = kernel32.func('void* __stdcall OpenProcess(uint32, int, uint32)');
const CloseHandle = kernel32.func('int __stdcall CloseHandle(void*)');
const QueryFullProcessImageNameW = kernel32.func('int __stdcall QueryFullProcessImageNameW(void*, uint32, _Out_ uint16*, _Inout_ uint32*)');
const GlobalAlloc = kernel32.func('void* __stdcall GlobalAlloc(uint32, size_t)');
const GlobalFree = kernel32.func('void* __stdcall GlobalFree(void*)');
const GlobalLock = kernel32.func('void* __stdcall GlobalLock(void*)');
const GlobalUnlock = kernel32.func('int __stdcall GlobalUnlock(void*)');
const GlobalSize = kernel32.func('size_t __stdcall GlobalSize(void*)');
const MoveMemory = kernel32.func('void __stdcall RtlMoveMemory(void*, const void*, size_t)');
const gdi32 = koffi.load('gdi32.dll');
const GetEnhMetaFileBits = gdi32.func('uint32 __stdcall GetEnhMetaFileBits(void*, uint32, void*)');
const SetEnhMetaFileBits = gdi32.func('void* __stdcall SetEnhMetaFileBits(uint32, const void*)');
const DeleteEnhMetaFile = gdi32.func('int __stdcall DeleteEnhMetaFile(void*)');

const GMEM_MOVEABLE = 0x0002;
const CF_TEXT = 1, CF_OEMTEXT = 7, CF_DIB = 8, CF_UNICODETEXT = 13, CF_ENHMETAFILE = 14, CF_LOCALE = 16, CF_DIBV5 = 17;
// Formats whose handle is not global memory. CF_BITMAP and CF_METAFILEPICT are rebuilt by Windows
// from CF_DIB and CF_ENHMETAFILE, which are kept. Palette and owner-display formats cannot be copied,
// and private (0x200-0x2FF) and GDI object (0x300-0x3FF) formats are not memory handles either.
const SKIP = new Set([2, 3, 9, 0x0080, 0x0082, 0x0083, 0x008E]);
const skipFormat = (f) => SKIP.has(f) || (f >= 0x200 && f <= 0x3FF);
const MAX_BYTES = 64 * 1024 * 1024;
// Password managers mark secrets with these, so JVoice never copies them and never puts them back.
const SENSITIVE = ['ExcludeClipboardContentFromMonitorProcessing', 'Clipboard Viewer Ignore'].map((n) => RegisterClipboardFormatW(n));
const CF_NO_HISTORY = RegisterClipboardFormatW('CanIncludeInClipboardHistory');
const CF_NO_CLOUD = RegisterClipboardFormatW('CanUploadToCloudClipboard');

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
function processName(pid) {
  const h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (!h) return '';
  try {
    const buf = new Uint16Array(1024), len = [buf.length];
    if (!QueryFullProcessImageNameW(h, 0, buf, len)) return '';
    const full = String.fromCharCode(...buf.subarray(0, len[0]));
    return full.slice(full.lastIndexOf('\\') + 1).toLowerCase();
  } finally { CloseHandle(h); }
}

// { id, pid, exe, cls } of the window the user is typing in. exe is the lower-case file name, cls the
// window class ('' if unknown). Console windows have a console class whatever program runs in them.
function foregroundWindow() {
  const h = GetForegroundWindow();
  if (!h) return null;
  const pid = [0];
  GetWindowThreadProcessId(h, pid);
  let exe = '';
  try { exe = processName(pid[0]); } catch { /* elevated or exited process */ }
  const buf = new Uint16Array(256);
  const n = GetClassNameW(h, buf, buf.length);
  return { id: String(koffi.address(h)), pid: pid[0], exe, cls: n > 0 ? String.fromCharCode(...buf.subarray(0, n)) : '' };
}

const isKeyDown = (vk) => (GetAsyncKeyState(vk) & 0x8000) !== 0;

// Sends key presses in one SendInput call. keys: [{ vk, up }]. Returns how many Windows accepted.
const KEYEVENTF_KEYUP = 0x2;
function sendKeys(keys) {
  const inputs = keys.map(({ vk, up }) => ({
    type: 1, // INPUT_KEYBOARD
    u: { ki: { wVk: vk, wScan: MapVirtualKeyW(vk, 0), dwFlags: up ? KEYEVENTF_KEYUP : 0, time: 0, dwExtraInfo: 0 } },
  }));
  return SendInput(inputs.length, inputs, koffi.sizeof(INPUT));
}

// owner: HWND as a BigInt. Restoring needs a real owner window, or SetClipboardData fails after EmptyClipboard.
async function withClipboard(fn, owner = 0n) {
  for (let i = 0; i < 10; i++) {
    if (OpenClipboard(owner)) {
      try { return fn(); } finally { CloseClipboard(); }
    }
    await new Promise((r) => setTimeout(r, 30)); // another app holds it
  }
  throw new Error('The clipboard is busy.');
}

// Returns { formats: [{format, data}], complete }, or null when the clipboard is too large to copy
// or holds a secret that its app marked as private.
async function snapshotClipboard() {
  return withClipboard(() => {
    if (SENSITIVE.some((f) => f && IsClipboardFormatAvailable(f))) return null;
    const list = [];
    for (let f = EnumClipboardFormats(0); f; f = EnumClipboardFormats(f)) list.push(f);
    // Windows makes these from CF_UNICODETEXT and CF_DIBV5 on its own, so copying them doubles the work.
    // CF_DIBV5 is the one kept, since it holds transparency that CF_DIB loses.
    const synth = new Set();
    if (list.includes(CF_UNICODETEXT)) [CF_TEXT, CF_OEMTEXT, CF_LOCALE].forEach((f) => synth.add(f));
    if (list.includes(CF_DIBV5)) synth.add(CF_DIB);
    const formats = [];
    let total = 0, complete = true;
    for (const f of list) {
      if (skipFormat(f) || synth.has(f)) continue;
      const h = GetClipboardData(f);
      if (!h) { complete = false; continue; }
      if (f === CF_ENHMETAFILE) {
        const size = GetEnhMetaFileBits(h, 0, null);
        if (!size) { complete = false; continue; }
        total += size;
        if (total > MAX_BYTES) return null;
        const data = Buffer.alloc(size);
        if (GetEnhMetaFileBits(h, size, data) !== size) { complete = false; continue; }
        formats.push({ format: f, data });
        continue;
      }
      const size = Number(GlobalSize(h));
      const p = size ? GlobalLock(h) : null;
      if (!p) { complete = false; continue; }
      try {
        total += size;
        if (total > MAX_BYTES) return null;
        const data = Buffer.alloc(size);
        MoveMemory(data, p, size);
        formats.push({ format: f, data });
      } finally { GlobalUnlock(h); }
    }
    return { formats, complete };
  });
}

// Builds a clipboard handle for one saved format, or null if Windows could not allocate it.
function makeHandle({ format, data }) {
  if (format === CF_ENHMETAFILE) {
    const h = SetEnhMetaFileBits(data.length, data);
    return h ? { h, free: () => DeleteEnhMetaFile(h) } : null;
  }
  const h = GlobalAlloc(GMEM_MOVEABLE, Math.max(1, data.length));
  if (!h) return null;
  const p = GlobalLock(h);
  if (!p) { GlobalFree(h); return null; }
  MoveMemory(p, data, data.length);
  GlobalUnlock(h);
  return { h, free: () => GlobalFree(h) };
}

// Puts a snapshot back. expectedSeq: skip if anything was copied since (checked while holding the lock).
// Returns 'restored', 'skipped' (clipboard changed) or 'failed' (nothing was cleared).
async function restoreClipboard(snap, owner, expectedSeq) {
  return withClipboard(() => {
    if (expectedSeq !== undefined && GetClipboardSequenceNumber() !== expectedSeq) return 'skipped';
    // Allocate everything first, so a failure leaves the current clipboard alone.
    const handles = [];
    for (const f of snap.formats) {
      const made = makeHandle(f);
      if (!made) { handles.forEach((x) => x.free()); return 'failed'; }
      handles.push({ format: f.format, ...made });
    }
    if (!EmptyClipboard()) { handles.forEach((x) => x.free()); return 'failed'; }
    let ok = true;
    for (const x of handles) {
      if (!SetClipboardData(x.format, x.h)) { x.free(); ok = false; } // on success the system owns the handle
    }
    return ok ? 'restored' : 'failed';
  }, owner);
}

// Puts text on the clipboard for a paste, marked so Windows clipboard history and cloud sync skip it.
async function setClipboardText(text, owner) {
  return withClipboard(() => {
    const units = Buffer.from(`${text}\0`, 'utf16le');
    const parts = [{ format: CF_UNICODETEXT, data: units }];
    const zero = Buffer.alloc(4); // DWORD 0 = "no"
    if (CF_NO_HISTORY) parts.push({ format: CF_NO_HISTORY, data: zero });
    if (CF_NO_CLOUD) parts.push({ format: CF_NO_CLOUD, data: zero });
    const handles = [];
    for (const p of parts) {
      const made = makeHandle(p);
      if (!made) { handles.forEach((x) => x.free()); return false; }
      handles.push({ format: p.format, ...made });
    }
    if (!EmptyClipboard()) { handles.forEach((x) => x.free()); return false; }
    let ok = true;
    for (const x of handles) if (!SetClipboardData(x.format, x.h)) { x.free(); if (x.format === CF_UNICODETEXT) ok = false; }
    return ok;
  }, owner);
}

const clipboardSequence = () => GetClipboardSequenceNumber();
// BrowserWindow.getNativeWindowHandle() returns the HWND bytes.
const hwndOf = (buf) => (buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0)));

module.exports = { foregroundWindow, isKeyDown, sendKeys, snapshotClipboard, restoreClipboard, setClipboardText, clipboardSequence, hwndOf };
