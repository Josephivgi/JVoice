'use strict';
// Win32 helpers through koffi: foreground window, physical key state, and a full clipboard snapshot.
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');

const GetForegroundWindow = user32.func('void* __stdcall GetForegroundWindow()');
const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(void*, _Out_ uint32*)');
const GetAsyncKeyState = user32.func('short __stdcall GetAsyncKeyState(int)');
const OpenClipboard = user32.func('int __stdcall OpenClipboard(intptr_t)');
const CloseClipboard = user32.func('int __stdcall CloseClipboard()');
const EmptyClipboard = user32.func('int __stdcall EmptyClipboard()');
const EnumClipboardFormats = user32.func('uint32 __stdcall EnumClipboardFormats(uint32)');
const GetClipboardData = user32.func('void* __stdcall GetClipboardData(uint32)');
const SetClipboardData = user32.func('void* __stdcall SetClipboardData(uint32, void*)');
const GetClipboardSequenceNumber = user32.func('uint32 __stdcall GetClipboardSequenceNumber()');
const GlobalAlloc = kernel32.func('void* __stdcall GlobalAlloc(uint32, size_t)');
const GlobalFree = kernel32.func('void* __stdcall GlobalFree(void*)');
const GlobalLock = kernel32.func('void* __stdcall GlobalLock(void*)');
const GlobalUnlock = kernel32.func('int __stdcall GlobalUnlock(void*)');
const GlobalSize = kernel32.func('size_t __stdcall GlobalSize(void*)');
const MoveMemory = kernel32.func('void __stdcall RtlMoveMemory(void*, const void*, size_t)');

const GMEM_MOVEABLE = 0x0002;
// Formats whose handle is not global memory (GDI objects, owner display). Windows rebuilds the
// bitmap and metafile ones from CF_DIB / CF_ENHMETAFILE data, so skipping them loses nothing.
const SKIP = new Set([2, 3, 9, 14, 0x0080, 0x0082, 0x0083, 0x008E]);
const MAX_BYTES = 64 * 1024 * 1024;

function foregroundWindow() {
  const h = GetForegroundWindow();
  if (!h) return null;
  const pid = [0];
  GetWindowThreadProcessId(h, pid);
  return { id: String(koffi.address(h)), pid: pid[0] };
}

const isKeyDown = (vk) => (GetAsyncKeyState(vk) & 0x8000) !== 0;

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

// Returns { formats: [{format, data}], complete } or null when the clipboard is too large to copy.
async function snapshotClipboard() {
  return withClipboard(() => {
    const formats = [];
    let total = 0, complete = true;
    for (let f = EnumClipboardFormats(0); f; f = EnumClipboardFormats(f)) {
      if (SKIP.has(f)) continue;
      const h = GetClipboardData(f);
      if (!h) { complete = false; continue; }
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

async function restoreClipboard(snap, owner) {
  return withClipboard(() => {
    EmptyClipboard();
    for (const { format, data } of snap.formats) {
      const h = GlobalAlloc(GMEM_MOVEABLE, Math.max(1, data.length));
      if (!h) continue;
      const p = GlobalLock(h);
      if (!p) { GlobalFree(h); continue; }
      MoveMemory(p, data, data.length);
      GlobalUnlock(h);
      if (!SetClipboardData(format, h)) GlobalFree(h); // on success the system owns the memory
    }
    return true;
  }, owner);
}

const clipboardSequence = () => GetClipboardSequenceNumber();
// BrowserWindow.getNativeWindowHandle() returns the HWND bytes.
const hwndOf = (buf) => (buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0)));

module.exports = { foregroundWindow, isKeyDown, snapshotClipboard, restoreClipboard, clipboardSequence, hwndOf };
