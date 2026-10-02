import { FRAME_HEADER_BYTES } from './frame';

/** Test helper (not imported by app code): builds render frames as the backend does (ADR-002 §6). */

export const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR = [0x49, 0x48, 0x44, 0x52];

export interface FrameOptions {
  magic?: number[];
  format?: number;
  width?: number;
  height?: number;
  /** Size written into the PNG header; defaults to the frame header's size. */
  pngWidth?: number;
  pngHeight?: number;
  /** Extra payload bytes after the PNG header, to check that the payload is passed through whole. */
  tail?: number;
}

/** A frame whose payload starts with a valid PNG signature and IHDR (enough for the parser; not a decodable image). */
export function makeFrame(options: FrameOptions = {}): Uint8Array<ArrayBuffer> {
  const { magic = [0x53, 0x48, 0x52, 0x31], format = 1, width = 300, height = 2, tail = 8 } = options;
  const { pngWidth = width, pngHeight = height } = options;
  const bytes = new Uint8Array(FRAME_HEADER_BYTES + 24 + tail);
  bytes.set(magic, 0);
  bytes[4] = format;
  const view = new DataView(bytes.buffer);
  view.setUint32(8, width, true);
  view.setUint32(12, height, true);
  bytes.set(PNG_SIGNATURE, FRAME_HEADER_BYTES);
  view.setUint32(FRAME_HEADER_BYTES + 8, 13); // IHDR length
  bytes.set(IHDR, FRAME_HEADER_BYTES + 12);
  view.setUint32(FRAME_HEADER_BYTES + 16, pngWidth);
  view.setUint32(FRAME_HEADER_BYTES + 20, pngHeight);
  return bytes;
}
