import type { AppEvent } from '../../api/app';
import { releaseImageBatch } from '../../api/imagesToPdf';
import { openWithBatch } from './state';

/** The `imagesDropped` push of the backend (ADR-049): a batch of dropped images, `skipped` of them unusable. */
export type ImagesDropped = Extract<AppEvent, { type: 'imagesDropped' }>;

/**
 * What the UI does with dropped images (DESIGN 3.43): only images open the Create PDF from images dialog with the batch; a mix with
 * PDFs is handled by the PDFs opening and the `img2pdf.mixedDrop` banner. A batch with no usable image is let go at once.
 */
export function handleImagesDropped(event: ImagesDropped): void {
  if (event.count === 0) {
    releaseImageBatch(event.batch).catch(() => undefined);
    return;
  }
  openWithBatch({ batch: event.batch, count: event.count, skipped: event.skipped });
}
