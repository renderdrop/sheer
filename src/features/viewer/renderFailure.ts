import type { AppError } from '../../api/errors';
import { useUi } from '../../stores/ui';

/**
 * The error that a failed render put in the banner. A page that renders later clears that banner, and only that one: an error
 * about opening a file (a drop with a file that is not a PDF) must not vanish because the page of another document came in.
 * Many pages fail for one reason (the engine is gone), so a failure of the same kind as the one shown does not replace it.
 */
let shown: AppError | null = null;

/** Shows a render failure in the banner, unless the banner shows one of the same code already. */
export function showRenderFailure(error: AppError): void {
  const banner = useUi.getState().banner;
  if (shown !== null && banner === shown && banner.code === error.code) return;
  shown = error;
  useUi.getState().showBanner(error);
}

/** Clears the banner if it is still the render failure, because a page rendered after all. */
export function clearRenderFailure(): void {
  if (shown !== null && useUi.getState().banner === shown) useUi.getState().dismissBanner();
  shown = null;
}
