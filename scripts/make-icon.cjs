'use strict';
// Draws assets/icon.png (256x256): cobalt rounded square with a white microphone.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const N = 256;
const px = Buffer.alloc(N * N * 4);
const bg = [58, 104, 232];
const clamp = (v) => Math.max(0, Math.min(1, v));
const sdRoundBox = (x, y, cx, cy, hw, hh, r) => {
  const qx = Math.abs(x - cx) - hw + r, qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const sdSeg = (x, y, ax, ay, bx, by) => {
  const pax = x - ax, pay = y - ay, bax = bx - ax, bay = by - ay;
  const h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay));
  return Math.hypot(pax - bax * h, pay - bay * h);
};
for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
  const X = x + 0.5, Y = y + 0.5;
  const shape = clamp(0.5 - sdRoundBox(X, Y, 128, 128, 120, 120, 56));
  // Mic capsule
  let d = sdRoundBox(X, Y, 128, 104, 28, 50, 28);
  // Holder arc: lower half of a ring
  const ring = Math.abs(Math.hypot(X - 128, Y - 112) - 50) - 8;
  const arc = Y > 112 ? ring : sdSeg(X, Y, 78, 96, 78, 112) - 8;
  const arcR = Y > 112 ? ring : sdSeg(X, Y, 178, 96, 178, 112) - 8;
  d = Math.min(d, arc, arcR);
  d = Math.min(d, sdSeg(X, Y, 128, 162, 128, 190) - 8, sdSeg(X, Y, 100, 196, 156, 196) - 8);
  const glyph = clamp(0.5 - d);
  const i = (y * N + x) * 4;
  for (let c = 0; c < 3; c++) px[i + c] = Math.round(bg[c] * (1 - glyph) + 255 * glyph);
  px[i + 3] = Math.round(255 * shape);
}
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcTable[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
const raw = Buffer.alloc(N * (N * 4 + 1));
for (let y = 0; y < N; y++) { raw[y * (N * 4 + 1)] = 0; px.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4); }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
fs.writeFileSync(path.join(__dirname, '..', 'assets', 'icon.png'), png);
console.log('wrote icon.png', png.length);
