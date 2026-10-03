import { call } from './call';
import { newChannel, parseJobId, type JobEvent, type JobId } from './jobs';

/*
 * Images to PDF (docs/ARCHITECTURE.md section 5, "Convert and output", ADR-049; commands/images_pdf.rs). The images come from Rust's open
 * dialog or from a batch dropped on the window (`AppEvent` `imagesDropped`); the target from Rust's Save As dialog.
 */

export type PaperSize = 'fit' | 'a4' | 'letter';

export interface ImagesToPdfOptions {
  source: { type: 'dialog' } | { type: 'batch'; batch: number };
  paper: PaperSize;
  orientation: 'auto' | 'portrait' | 'landscape';
  /** 0..=72. */
  marginPt: number;
}

/**
 * Builds the PDF and opens it (`done.opened`; `done.skipped` images were left out). Resolves to `null` when a dialog was cancelled.
 * Rejects with `invalid_argument` `image` when no image could be used, `not_found` `imageBatch` for an expired batch.
 */
export async function imagesToPdf(opts: ImagesToPdfOptions, onEvent: (event: JobEvent) => void): Promise<JobId | null> {
  return parseJobId(await call<unknown>('images_to_pdf', { opts, onEvent: newChannel(onEvent) }));
}

/** Lets go of a dropped batch; an unknown id is not an error. */
export async function releaseImageBatch(batch: number): Promise<void> {
  await call<void>('release_image_batch', { batch });
}
