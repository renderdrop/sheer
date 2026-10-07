// APNG encoder (RGBA 8-bit) and a small PNG-to-RGBA decoder for CDP screenshots. node:zlib only, no dependencies.
import { deflateSync, inflateSync } from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Decode an 8-bit non-interlaced grey/RGB/RGBA PNG buffer to { width, height, data: RGBA Buffer }. */
export function decodePngRgba(buf) {
  let pos = 8;
  let width = 0;
  let height = 0;
  let type = 0;
  const parts = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const name = buf.toString('ascii', pos + 4, pos + 8);
    const d = buf.subarray(pos + 8, pos + 8 + len);
    if (name === 'IHDR') {
      width = d.readUInt32BE(0);
      height = d.readUInt32BE(4);
      type = d[9];
      if (d[8] !== 8 || d[12] !== 0) throw new Error('unsupported PNG (need 8-bit, not interlaced)');
    } else if (name === 'IDAT') parts.push(d);
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
  if (bpp === 4) return { width, height, data: px };
  const data = Buffer.alloc(width * height * 4);
  const grey = bpp < 3;
  for (let i = 0; i < width * height; i++) {
    const s = i * bpp;
    data[i * 4] = px[s];
    data[i * 4 + 1] = grey ? px[s] : px[s + 1];
    data[i * 4 + 2] = grey ? px[s] : px[s + 2];
    data[i * 4 + 3] = bpp === 2 ? px[s + 1] : 255;
  }
  return { width, height, data };
}

/** Bounding box { x, y, w, h } of the pixels that differ between two RGBA buffers of equal size, or null when identical. */
export function diffBox(a, b, width, height) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    if (a.compare(b, row, row + width * 4, row, row + width * 4) === 0) continue;
    for (let x = 0; x < width; x++) {
      const o = row + x * 4;
      if (a.readUInt32LE(o) !== b.readUInt32LE(o)) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** Deflated scanlines (filter 0 for the first row, 2 = Up after) of a box inside an RGBA image. */
function region(data, width, box) {
  const rowLen = box.w * 4;
  const out = Buffer.alloc((rowLen + 1) * box.h);
  for (let y = 0; y < box.h; y++) {
    const o = y * (rowLen + 1);
    const cur = ((box.y + y) * width + box.x) * 4;
    const prev = cur - width * 4;
    out[o] = y > 0 ? 2 : 0;
    for (let i = 0; i < rowLen; i++) out[o + 1 + i] = y > 0 ? (data[cur + i] - data[prev + i]) & 255 : data[cur + i];
  }
  return deflateSync(out, { level: 9 });
}

/**
 * encodeApng(frames, { loops = 0 }) -> { buffer, boxes }
 * frames: [{ width, height, data: RGBA Buffer, delayMs }] of equal size. Identical consecutive frames merge their delays; later frames
 * store only the changed bounding box (dispose NONE, blend SOURCE). boxes lists the stored box of each written frame.
 */
export function encodeApng(frames, { loops = 0 } = {}) {
  if (!frames.length) throw new Error('no frames');
  const { width, height } = frames[0];
  const kept = [];
  for (const f of frames) {
    if (f.width !== width || f.height !== height) throw new Error('frames must have equal size');
    const last = kept[kept.length - 1];
    if (last && last.data.equals(f.data)) last.delayMs += f.delayMs;
    else kept.push({ data: f.data, delayMs: f.delayMs });
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(kept.length, 0);
  actl.writeUInt32BE(loops, 4);
  const out = [SIG, chunk('IHDR', ihdr), chunk('acTL', actl)];
  const boxes = [];
  let seq = 0;
  kept.forEach((f, i) => {
    const box = i === 0 ? { x: 0, y: 0, w: width, h: height } : diffBox(kept[i - 1].data, f.data, width, height);
    boxes.push(box);
    const fc = Buffer.alloc(26);
    fc.writeUInt32BE(seq++, 0);
    fc.writeUInt32BE(box.w, 4);
    fc.writeUInt32BE(box.h, 8);
    fc.writeUInt32BE(box.x, 12);
    fc.writeUInt32BE(box.y, 16);
    fc.writeUInt16BE(Math.min(65535, Math.max(1, Math.round(f.delayMs))), 20);
    fc.writeUInt16BE(1000, 22);
    fc[24] = 0; // APNG_DISPOSE_OP_NONE
    fc[25] = 0; // APNG_BLEND_OP_SOURCE
    out.push(chunk('fcTL', fc));
    const z = region(f.data, width, box);
    if (i === 0) out.push(chunk('IDAT', z));
    else {
      const fd = Buffer.alloc(4 + z.length);
      fd.writeUInt32BE(seq++, 0);
      z.copy(fd, 4);
      out.push(chunk('fdAT', fd));
    }
  });
  out.push(chunk('IEND', Buffer.alloc(0)));
  return { buffer: Buffer.concat(out), boxes };
}

/** Encode a single RGBA frame as a plain PNG (reduced-motion still). */
export function encodePng({ width, height, data }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', region(data, width, { x: 0, y: 0, w: width, h: height })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
