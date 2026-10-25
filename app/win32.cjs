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
const gdi32 = koffi.load('gdi32.dll');
const GetEnhMetaFileBits = gdi32.func('uint32 __stdcall GetEnhMetaFileBits(void*, uint32, void*)');
const SetEnhMetaFileBits = gdi32.func('void* __stdcall SetEnhMetaFileBits(uint32, const void*)');
const DeleteEnhMetaFile = gdi32.func('int __stdcall DeleteEnhMetaFile(void*)');

const GMEM_MOVEABLE = 0x0002;
const CF_ENHMETAFILE = 14;
// Formats whose handle is not global memory. CF_BITMAP and CF_METAFILEPICT are rebuilt by Windows
// from CF_DIB and CF_ENHMETAFILE, which are kept. Palette and owner-display formats cannot be copied.
const SKIP = new Set([2, 3, 9, 0x0080, 0x0082, 0x0083, 0x008E]);
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

const clipboardSequence = () => GetClipboardSequenceNumber();
// BrowserWindow.getNativeWindowHandle() returns the HWND bytes.
const hwndOf = (buf) => (buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0)));

module.exports = { foregroundWindow, isKeyDown, snapshotClipboard, restoreClipboard, clipboardSequence, hwndOf };
