import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
// @ts-expect-error plain .mjs module without types
import { crc32, decodePngRgba, diffBox, encodeApng, encodePng } from './apng.mjs';

const W = 8;
const H = 6;
function frame(fill: number, patch?: { x: number; y: number; w: number; h: number; v: number }, delayMs = 100) {
  const data = Buffer.alloc(W * H * 4, fill);
  if (patch) {
    for (let y = patch.y; y < patch.y + patch.h; y++)
      for (let x = patch.x; x < patch.x + patch.w; x++) data.fill(patch.v, (y * W + x) * 4, (y * W + x) * 4 + 4);
  }
  return { width: W, height: H, data, delayMs };
}

function parse(buf: Buffer) {
  const chunks: { type: string; data: Buffer; crcOk: boolean }[] = [];
  let pos = 8;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    const crc = buf.readUInt32BE(pos + 8 + len);
    chunks.push({ type, data, crcOk: crc === crc32(buf.subarray(pos + 4, pos + 8 + len)) });
    pos += 12 + len;
  }
  return chunks;
}

/** Inflate and unfilter (types 0 and 2 only) a region to raw RGBA. */
function unpack(z: Buffer, w: number, h: number) {
  const raw = inflateSync(z);
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (w * 4 + 1)];
    for (let i = 0; i < w * 4; i++) {
      const v = raw[y * (w * 4 + 1) + 1 + i];
      out[y * w * 4 + i] = f === 2 ? (v + out[(y - 1) * w * 4 + i]) & 255 : v;
    }
  }
  return out;
}

describe('apng', () => {
  it('encodes a valid 2-frame APNG that round-trips', () => {
    const a = frame(10);
    const b = frame(10, { x: 2, y: 1, w: 3, h: 2, v: 200 });
    const { buffer, boxes } = encodeApng([a, b]);
    expect(buffer.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const cs = parse(buffer);
    expect(cs.every((c) => c.crcOk)).toBe(true);
    expect(cs.map((c) => c.type)).toEqual(['IHDR', 'acTL', 'fcTL', 'IDAT', 'fcTL', 'fdAT', 'IEND']);
    expect(cs[1].data.readUInt32BE(0)).toBe(2);
    expect(cs[1].data.readUInt32BE(4)).toBe(0);
    expect(boxes[1]).toEqual({ x: 2, y: 1, w: 3, h: 2 });
    const fc1 = cs[4].data;
    expect([fc1.readUInt32BE(4), fc1.readUInt32BE(8), fc1.readUInt32BE(12), fc1.readUInt32BE(16)]).toEqual([
      3, 2, 2, 1,
    ]);
    expect(fc1.readUInt32BE(0)).toBe(1);
    expect(cs[5].data.readUInt32BE(0)).toBe(2);
    const canvas = unpack(cs[3].data, W, H);
    expect(canvas.equals(a.data)).toBe(true);
    const patch = unpack(cs[5].data.subarray(4), 3, 2);
    for (let y = 0; y < 2; y++) patch.copy(canvas, ((1 + y) * W + 2) * 4, y * 12, y * 12 + 12);
    expect(canvas.equals(b.data)).toBe(true);
  });

  it('merges identical frames and sums delays', () => {
    const { buffer } = encodeApng([frame(5), frame(5), frame(6)]);
    const cs = parse(buffer);
    expect(cs[1].data.readUInt32BE(0)).toBe(2);
    expect(cs[2].data.readUInt16BE(20)).toBe(200);
    expect(cs[2].data.readUInt16BE(22)).toBe(1000);
  });

  it('diffBox returns null for identical frames', () => {
    expect(diffBox(frame(1).data, frame(1).data, W, H)).toBeNull();
  });

  it('PNG still round-trips through decodePngRgba', () => {
    const f = frame(10, { x: 1, y: 1, w: 2, h: 2, v: 99 });
    const d = decodePngRgba(encodePng(f));
    expect(d.width).toBe(W);
    expect(d.data.equals(f.data)).toBe(true);
  });
});
