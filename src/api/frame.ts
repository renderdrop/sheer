import { readPngSize } from '../lib/png';

/**
 * Render frame returned by `render_page` (ADR-002 §6; mirrors src-tauri/src/engine/encode.rs). All integers are
 * little-endian:
 *
 * | Offset | Size | Field |
 * |---|---|---|
 * | 0 | 4 | magic `"SHR1"` |
 * | 4 | 1 | format: 1 = PNG, 8-bit RGB. Format 2 (raw RGBA8) is reserved for the spike gate and not produced yet |
 * | 5 | 3 | reserved |
 * | 8 | 4 | width in pixels |
 * | 12 | 4 | height in pixels |
 * | 16 | n | payload |
 */
const MAGIC = [0x53, 0x48, 0x52, 0x31];
const FORMAT_PNG_RGB = 1;
export const FRAME_HEADER_BYTES = 16;

/** Largest frame side the backend produces (`MAX_RENDER_SIDE_PX` in src-tauri/src/limits.rs). */
export const MAX_FRAME_SIDE = 4096;

export interface RenderFrame {
  /** PNG bytes (a view into the response, not a copy). */
  data: Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
}

/**
 * Validates a response body and splits it into size and PNG payload. `null` if it is not a frame this app understands:
 * wrong magic, unknown format, absurd size, or a header that disagrees with the PNG inside.
 */
export function parseFrame(bytes: Uint8Array<ArrayBuffer>): RenderFrame | null {
  if (bytes.length <= FRAME_HEADER_BYTES) return null;
  if (MAGIC.some((value, i) => bytes[i] !== value)) return null;
  if (bytes[4] !== FORMAT_PNG_RGB) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(8, true);
  const height = view.getUint32(12, true);
  if (width < 1 || height < 1 || width > MAX_FRAME_SIDE || height > MAX_FRAME_SIDE) return null;
  const data = bytes.subarray(FRAME_HEADER_BYTES);
  const png = readPngSize(data);
  if (png === null || png.width !== width || png.height !== height) return null;
  return { data, width, height };
}
