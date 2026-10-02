const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR = [0x49, 0x48, 0x44, 0x52];
const HEADER_BYTES = 24;

/** Pixel size from the PNG header, without decoding the image. `null` if `bytes` is not a PNG. */
export function readPngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < HEADER_BYTES) return null;
  if (SIGNATURE.some((value, i) => bytes[i] !== value)) return null;
  if (IHDR.some((value, i) => bytes[12 + i] !== value)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : null;
}
