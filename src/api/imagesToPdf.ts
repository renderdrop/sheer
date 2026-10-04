import { call } from './call';
import { toAppError } from './errors';
import { parseFrame, type RenderFrame } from './frame';
import { newChannel, parseJobId, type JobEvent, type JobId } from './jobs';

/*
 * Images to PDF (docs/ARCHITECTURE.md section 5, "Convert and output", ADR-049; commands/images_pdf.rs). The images wait in a batch
 * the backend holds: from Rust's open dialog (`pickImages`) or from a drop (`AppEvent` `imagesDropped`). The list shows names and
 * thumbnails only; no path or pixel buffer reaches the UI. The target comes from Rust's Save As dialog.
 */

export type PaperSize = 'fit' | 'a4' | 'letter';

export interface ImagesToPdfOptions {
  source: { type: 'dialog' } | { type: 'batch'; batch: number };
  paper: PaperSize;
  orientation: 'auto' | 'portrait' | 'landscape';
  /** 0..=72. */
  marginPt: number;
}

/** One image of a batch: its place in the batch (stable), the file name only, and the declared size (0 when unreadable). */
export interface BatchItem {
  index: number;
  name: string;
  width: number;
  height: number;
}

/** What the picker made of the chosen files: the batch, its size now, how many were added and how many files were left out. */
export interface PickedImages {
  batch: number;
  count: number;
  added: number;
  skipped: number;
}

/** The most images of one batch (`MAX_IMAGES_PER_PDF`). */
export const MAX_BATCH_IMAGES = 500;

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;

/**
 * Builds the PDF and opens it (`done.opened`; `done.skipped` images were left out). Resolves to `null` when a dialog was cancelled.
 * `order` (batch source only) lists the batch indices to use, in page order: a permutation or a subset, no repeats, at most 500.
 * Rejects with `invalid_argument` `image` when no image could be used (or `order` is empty), `order` for a bad order, `not_found`
 * `imageBatch` for an expired batch.
 */
export async function imagesToPdf(
  opts: ImagesToPdfOptions,
  onEvent: (event: JobEvent) => void,
  order?: readonly number[],
): Promise<JobId | null> {
  const args: Record<string, unknown> = { opts, onEvent: newChannel(onEvent) };
  if (order !== undefined) args.order = [...order];
  return parseJobId(await call<unknown>('images_to_pdf', args));
}

/** Lets go of a batch; an unknown id is not an error. */
export async function releaseImageBatch(batch: number): Promise<void> {
  await call<void>('release_image_batch', { batch });
}

/**
 * Rust's open dialog (PNG, JPEG, multi-select): the images are added to `batch`, or to a new batch without one. `null`: cancelled or
 * nothing usable was chosen. Rejects with `not_found` `imageBatch` for an expired batch.
 */
export async function pickImages(batch?: number): Promise<PickedImages | null> {
  const answer = await call<unknown>('pick_images', batch === undefined ? {} : { batch });
  if (answer === null) return null;
  const m = (typeof answer === 'object' ? answer : {}) as Record<string, unknown>;
  if (!isCount(m.batch) || !isCount(m.count) || !isCount(m.added) || !isCount(m.skipped)) throw toAppError(null);
  return { batch: m.batch, count: m.count, added: m.added, skipped: m.skipped };
}

/** The images of a batch in the order they were added. */
export async function listImageBatch(batch: number): Promise<BatchItem[]> {
  const answer = await call<unknown>('list_image_batch', { batch });
  if (!Array.isArray(answer) || answer.length > MAX_BATCH_IMAGES) throw toAppError(null);
  return (answer as unknown[]).map((item): BatchItem => {
    const m = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    if (!isCount(m.index) || typeof m.name !== 'string' || !isCount(m.width) || !isCount(m.height))
      throw toAppError(null);
    return { index: m.index, name: m.name, width: m.width, height: m.height };
  });
}

/** A PNG frame of one image of a batch, at most `maxPx` (16 to 512) on its long side. Rejects when the image cannot be decoded. */
export async function getImageBatchPreview(batch: number, index: number, maxPx: number): Promise<RenderFrame> {
  const body = await call<ArrayBuffer>('get_image_batch_preview', { batch, index, maxPx });
  const frame = parseFrame(new Uint8Array(body));
  if (frame === null) throw toAppError(null);
  return frame;
}
