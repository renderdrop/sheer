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

/** How long the frames stay after the native dialog was told to print (ADR-107): the time its pages need to be laid out and spooled. */
export const PRINT_GRACE_MS = 30_000;
/** The longest the frames are kept when no `afterprint` ever comes. */
export const PRINT_LINGER_MS = 5 * 60_000;

let pendingCleanup: { stop: () => void } | null = null;

/** Revokes every blob URL and empties the surface. */
export function clearSurface(): void {
  pendingCleanup?.stop();
  pendingCleanup = null;
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
  // Frames of an earlier print that are still waiting for their cleanup go now.
  clearSurface();
  flushSync(() => usePrintSurface.setState({ frames }));
  const images = Array.from(document.querySelectorAll<HTMLImageElement>('[data-print-surface] > img'));
  await Promise.all(images.map((image) => (typeof image.decode === 'function' ? image.decode() : Promise.resolve())));
}

/**
 * Clears the surface once the print is over: shortly after `afterprint`, or after [`PRINT_LINGER_MS`] at the latest.
 * `Webview::print()` returns when the dialog is *opened*, not when it is done: on macOS (WKWebView) it is a sheet that lays out
 * and paints the page after the user confirms, so a surface emptied at once prints blank pages (ADR-107).
 */
function clearWhenPrinted(): void {
  pendingCleanup?.stop();
  const timers: ReturnType<typeof setTimeout>[] = [];
  const onAfterPrint = () => {
    timers.push(setTimeout(clearSurface, PRINT_GRACE_MS));
  };
  window.addEventListener('afterprint', onAfterPrint, { once: true });
  timers.push(setTimeout(clearSurface, PRINT_LINGER_MS));
  pendingCleanup = {
    stop: () => {
      window.removeEventListener('afterprint', onAfterPrint);
      timers.forEach(clearTimeout);
    },
  };
}

/**
 * Opens the print dialog. A dialog that failed to open drops the surface at once and shows the banner; one that opened leaves the
 * frames in place until the print is over (see [`clearWhenPrinted`]). The set in the backend is released right away: the pages
 * are blob URLs by now.
 */
export async function handOver(printId: number): Promise<void> {
  usePrintSurface.setState({ printing: true });
  let opened = false;
  try {
    await openPrintDialog(printId);
    opened = true;
  } catch (caught) {
    useUi.getState().showBanner(toAppError(caught));
  } finally {
    if (opened) clearWhenPrinted();
    else clearSurface();
    usePrintSurface.setState({ printing: false });
    await releasePrint(printId).catch(() => undefined);
  }
}
