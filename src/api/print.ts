import { call } from './call';
import { toAppError } from './errors';
import { newChannel, requireJobId, type JobEvent, type JobId } from './jobs';
import type { PageSelection } from './pageSelection';

/*
 * Print (docs/ARCHITECTURE.md section 5, "Convert and output", ADR-049; commands/print.rs). Rust renders the pages into a print set;
 * the UI fetches the frames into blob URLs on a print-only surface, then asks Rust to open the dialog.
 */

export interface PrintOptions {
  pages: PageSelection;
  annotations: boolean;
  quality: 'standard' | 'high';
  autoRotate: boolean;
  /** The paper orientation landscape pages are turned to. */
  paper: 'portrait' | 'landscape';
}

/** Which route opened the dialog: the OS dialog, or the webview's own print preview (still local). */
export type PrintRoute = 'system' | 'webview' | 'recorded';

/** One page of a print set: SHR1 header (format 3 = JPEG), then the JPEG. */
export interface PrintFrame {
  /** JPEG bytes (a view into the response, not a copy). */
  data: Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
}

const MAGIC = [0x53, 0x48, 0x52, 0x31];
const FORMAT_JPEG = 3;
const HEADER_BYTES = 16;
/** Longest side of a print frame in pixels: a 14 400 pt page at 150 dpi is far beyond this, the backend lowers the dpi first. */
const MAX_SIDE = 10_000;

/** Validates a print frame: `null` if it is not one (wrong magic or format, absurd size, not a JPEG). */
export function parsePrintFrame(bytes: Uint8Array<ArrayBuffer>): PrintFrame | null {
  if (bytes.length <= HEADER_BYTES || MAGIC.some((value, i) => bytes[i] !== value)) return null;
  if (bytes[4] !== FORMAT_JPEG) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(8, true);
  const height = view.getUint32(12, true);
  if (width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE) return null;
  const data = bytes.subarray(HEADER_BYTES);
  // JPEG start of image.
  if (data[0] !== 0xff || data[1] !== 0xd8 || data[2] !== 0xff) return null;
  return { data, width, height };
}

/**
 * Renders the pages to print; the set arrives in `done.print`. Rejects with `read_only` `permission`, `limit_exceeded` `printJob`
 * or `invalid_argument` `pageSelection`.
 */
export async function preparePrint(
  docId: number,
  opts: PrintOptions,
  onEvent: (event: JobEvent) => void,
): Promise<JobId> {
  return requireJobId(await call<unknown>('prepare_print', { docId, opts, onEvent: newChannel(onEvent) }));
}

/** One frame of a finished set, `index < done.print.pages`. */
export async function getPrintPage(printId: number, index: number): Promise<PrintFrame> {
  const body = await call<ArrayBuffer>('get_print_page', { printId, index });
  const frame = parsePrintFrame(new Uint8Array(body));
  if (frame === null) throw toAppError(null);
  return frame;
}

/** Opens the print dialog for a complete set; resolves when Rust has handed it over. */
export async function openPrintDialog(printId: number): Promise<PrintRoute> {
  const route = await call<unknown>('open_print_dialog', { printId });
  if (route !== 'system' && route !== 'webview' && route !== 'recorded') throw toAppError(null);
  return route;
}

/** Drops a print set; an unknown id is not an error. */
export async function releasePrint(printId: number): Promise<void> {
  await call<void>('release_print', { printId });
}
