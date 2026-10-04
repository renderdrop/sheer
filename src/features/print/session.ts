import { flushSync } from 'react-dom';
import { create } from 'zustand';

import { toAppError } from '../../api/errors';
import { getPrintPage, openPrintDialog, releasePrint } from '../../api/print';
import { useUi } from '../../stores/ui';

export interface SurfaceFrame {
  /** Blob URL of the JPEG; revoked by `clearSurface`. */
  url: string;
  width: number;
  height: number;
}

/**
 * The frames the print surface shows (DESIGN 3.44). Empty except while a print runs. `printing` is true while the system print
 * dialog is open, so a second print cannot replace the surface under it.
 */
export const usePrintSurface = create<{ frames: readonly SurfaceFrame[]; printing?: boolean }>()(() => ({
  frames: [],
}));

/** Revokes every blob URL and empties the surface. */
export function clearSurface(): void {
  for (const frame of usePrintSurface.getState().frames) URL.revokeObjectURL(frame.url);
  usePrintSurface.setState({ frames: [] });
}

/**
 * Fetches the frames of a print set into blob URLs. Resolves `null` when `cancelled()` turned true (nothing stays allocated);
 * rejects on a failed frame (also with nothing allocated).
 */
export async function fetchFrames(
  printId: number,
  pages: number,
  onProgress: (done: number) => void,
  cancelled: () => boolean,
): Promise<SurfaceFrame[] | null> {
  const frames: SurfaceFrame[] = [];
  const drop = () => frames.forEach((frame) => URL.revokeObjectURL(frame.url));
  try {
    for (let index = 0; index < pages; index += 1) {
      if (cancelled()) {
        drop();
        return null;
      }
      onProgress(index);
      const frame = await getPrintPage(printId, index);
      frames.push({
        url: URL.createObjectURL(new Blob([frame.data], { type: 'image/jpeg' })),
        width: frame.width,
        height: frame.height,
      });
    }
  } catch (caught) {
    drop();
    throw caught;
  }
  if (cancelled()) {
    drop();
    return null;
  }
  return frames;
}

/** Puts the frames on the surface and waits until every image is decoded, so the print does not start on blank sheets. */
export async function stageFrames(frames: readonly SurfaceFrame[]): Promise<void> {
  flushSync(() => usePrintSurface.setState({ frames }));
  const images = Array.from(document.querySelectorAll<HTMLImageElement>('[data-print-surface] > img'));
  await Promise.all(images.map((image) => (typeof image.decode === 'function' ? image.decode() : Promise.resolve())));
}

/** Opens the print dialog, and when it returns drops the set and the blob URLs. Failures go to the banner. */
export async function handOver(printId: number): Promise<void> {
  usePrintSurface.setState({ printing: true });
  try {
    await openPrintDialog(printId);
  } catch (caught) {
    useUi.getState().showBanner(toAppError(caught));
  } finally {
    clearSurface();
    usePrintSurface.setState({ printing: false });
    await releasePrint(printId).catch(() => undefined);
  }
}
