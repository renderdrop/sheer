/**
 * The spot an annotation has on the page, flashed after a jump to it (DESIGN 3.59, MOTION 4.8): the frame of the annotation blinks
 * twice, opacity only. The page may still be coming into view, so the frame is looked for for a moment. Reduced motion: no flash (the
 * selection already marks it).
 */
import { FLASH_MS } from '../../lib/motion';

const TRIES = 30;

export function flashAnnotation(id: number): void {
  if (typeof window === 'undefined' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true) return;
  let tries = 0;
  const look = () => {
    const frame = document.querySelector<HTMLElement>(`[data-annot-frame="${id}"]`);
    if (frame !== null && typeof frame.animate === 'function') {
      frame.animate({ opacity: [1, 0.3, 1, 0.3, 1] }, { duration: FLASH_MS, easing: 'ease-in-out' });
      return;
    }
    tries += 1;
    if (tries < TRIES) window.requestAnimationFrame(look);
  };
  window.requestAnimationFrame(look);
}
