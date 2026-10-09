// Minimal PNG reader for acceptance checks: 8-bit grey/RGB/RGBA, non-interlaced (what CDP screenshots are). Returns { width, height, lum(x, y) }.
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

export function readPng(path) {
  const buf = readFileSync(path);
  let pos = 8;
  let width = 0;
  let height = 0;
  let type = 0;
  const parts = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const name = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (name === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      type = data[9];
      if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported PNG (need 8-bit, not interlaced)');
    } else if (name === 'IDAT') parts.push(data);
    pos += 12 + len;
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[type];
  if (!bpp) throw new Error(`unsupported PNG colour type ${type}`);
  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * bpp;
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? px[y * stride + i - bpp] : 0;
      const b = y > 0 ? px[(y - 1) * stride + i] : 0;
      const c = i >= bpp && y > 0 ? px[(y - 1) * stride + i - bpp] : 0;
      let v = src[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + i] = v & 255;
    }
  }
  const lum = (x, y) => {
    const o = y * stride + x * bpp;
    return bpp < 3 ? px[o] : 0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2];
  };
  /** [r, g, b] of a pixel (grey replicated). */
  const rgb = (x, y) => {
    const o = y * stride + x * bpp;
    return bpp < 3 ? [px[o], px[o], px[o]] : [px[o], px[o + 1], px[o + 2]];
  };
  return { width, height, lum, rgb };
}

/** Darkest and lightest luminance (0..255) inside a rect given in device pixels. */
export function lumRange(png, { left, top, right, bottom }) {
  let min = 255;
  let max = 0;
  for (let y = Math.max(0, Math.floor(top)); y < Math.min(png.height, Math.ceil(bottom)); y++) {
    for (let x = Math.max(0, Math.floor(left)); x < Math.min(png.width, Math.ceil(right)); x++) {
      const l = png.lum(x, y);
      if (l < min) min = l;
      if (l > max) max = l;
    }
  }
  return { min, max };
}
