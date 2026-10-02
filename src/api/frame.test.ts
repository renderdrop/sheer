import { describe, expect, it } from 'vitest';

import { FRAME_HEADER_BYTES, MAX_FRAME_SIDE, parseFrame } from './frame';
import { PNG_SIGNATURE, makeFrame } from './frame.testutil';

describe('parseFrame', () => {
  it('splits a valid frame into size and PNG payload', () => {
    const bytes = makeFrame({ width: 300, height: 2, tail: 5 });
    const frame = parseFrame(bytes);
    expect(frame).not.toBeNull();
    expect(frame?.width).toBe(300);
    expect(frame?.height).toBe(2);
    // The payload is the PNG, starting right after the 16-byte header, and shares memory with the response.
    expect(frame?.data.length).toBe(bytes.length - FRAME_HEADER_BYTES);
    expect(Array.from(frame?.data.subarray(0, 8) ?? [])).toEqual(PNG_SIGNATURE);
    expect(frame?.data.buffer).toBe(bytes.buffer);
  });

  it('reads the header as little-endian', () => {
    // 0x0100 = 256 wide: wrong if read as big-endian (65536).
    expect(parseFrame(makeFrame({ width: 256, height: 1 }))).toMatchObject({ width: 256, height: 1 });
  });

  it('accepts the largest frame and rejects anything bigger', () => {
    expect(parseFrame(makeFrame({ width: MAX_FRAME_SIDE, height: MAX_FRAME_SIDE }))).not.toBeNull();
    expect(parseFrame(makeFrame({ width: MAX_FRAME_SIDE + 1, height: 1 }))).toBeNull();
    expect(parseFrame(makeFrame({ width: 1, height: MAX_FRAME_SIDE + 1 }))).toBeNull();
  });

  it('rejects anything that is not a frame', () => {
    expect(parseFrame(new Uint8Array(0))).toBeNull();
    expect(parseFrame(new Uint8Array(FRAME_HEADER_BYTES))).toBeNull();
    expect(parseFrame(makeFrame({ magic: [0x53, 0x48, 0x52, 0x32] }))).toBeNull();
    // A bare PNG without the frame header.
    expect(parseFrame(makeFrame().subarray(FRAME_HEADER_BYTES) as Uint8Array<ArrayBuffer>)).toBeNull();
  });

  it('rejects unknown formats, including the reserved raw format', () => {
    expect(parseFrame(makeFrame({ format: 0 }))).toBeNull();
    expect(parseFrame(makeFrame({ format: 2 }))).toBeNull();
    expect(parseFrame(makeFrame({ format: 255 }))).toBeNull();
  });

  it('rejects zero sizes and headers that disagree with the PNG', () => {
    expect(parseFrame(makeFrame({ width: 0, height: 5, pngWidth: 0 }))).toBeNull();
    expect(parseFrame(makeFrame({ width: 5, height: 0, pngHeight: 0 }))).toBeNull();
    expect(parseFrame(makeFrame({ width: 10, height: 10, pngWidth: 11 }))).toBeNull();
    expect(parseFrame(makeFrame({ width: 10, height: 10, pngHeight: 9 }))).toBeNull();
  });
});
