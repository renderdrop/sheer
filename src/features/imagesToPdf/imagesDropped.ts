// owned by U2
import type { AppEvent } from '../../api/app';

/** The `imagesDropped` push of the backend (ADR-049): a batch of dropped images, `skipped` of them unusable. */
export type ImagesDropped = Extract<AppEvent, { type: 'imagesDropped' }>;

/**
 * What the UI does with dropped images (DESIGN 3.43): only images open the Create PDF from images dialog with the batch; a mix with
 * PDFs is handled by the PDFs opening and the `img2pdf.mixedDrop` banner. Stub: `appEvents.ts` delegates here; U2 implements it.
 */
export function handleImagesDropped(event: ImagesDropped): void {
  void event;
}
