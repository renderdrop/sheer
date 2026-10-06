import { useEffect, useRef } from 'react';

import { prefersReducedMotion, tokenMs } from '../../components/glide';
import { EASE_OUT } from '../../lib/motion';
import type { PageLayerProps } from '../viewer/pageLayer';
import { useMarks } from './marks';

/**
 * The target band of a jump and the outline of the run a return came from (DESIGN 3.11 L6, L7), drawn inside the page. The band is
 * `--smartlink-hover-fill` (multiplied), pulses 1, .4, 1 once and fades after its hold; under reduced motion it is the 2 px Ink
 * outline instead, as is the origin. It takes no pointer events and is hidden from assistive technology (the jump is announced).
 */
export function JumpMarkLayer({ docId, pageIndex, boxWidth, boxHeight, widthPt, heightPt }: PageLayerProps) {
  const mark = useMarks((state) => state.mark);
  const element = useRef<HTMLDivElement>(null);
  const nonce = mark?.nonce;
  const kind = mark?.kind;

  useEffect(() => {
    const node = element.current;
    if (node === null || kind !== 'band' || prefersReducedMotion() || typeof node.animate !== 'function') return;
    const step = tokenMs('--motion-fast', 120);
    node.animate({ opacity: [1, 0.4, 1] }, { duration: step * 2, easing: `cubic-bezier(${EASE_OUT.join(', ')})` });
  }, [nonce, kind]);

  if (mark === null || mark.docId !== docId || mark.pageId !== pageIndex || widthPt <= 0 || heightPt <= 0) return null;
  // The long side of the shown box is the long side of the page, whatever the view rotation.
  const scale = Math.max(boxWidth, boxHeight) / Math.max(widthPt, heightPt);
  const outline = mark.kind === 'origin' || prefersReducedMotion();
  return (
    <div
      ref={element}
      aria-hidden="true"
      data-history-mark={mark.kind}
      className="pointer-events-none absolute z-canvas-annotations rounded-sm transition-opacity duration-[var(--motion-fast-exit)] ease-out"
      style={{
        left: mark.rect.x * scale,
        top: mark.rect.y * scale,
        width: mark.rect.w * scale,
        height: mark.rect.h * scale,
        opacity: mark.fading ? 0 : 1,
        ...(outline
          ? { outline: 'var(--outline-jump) solid var(--color-ink)' }
          : { background: 'var(--smartlink-hover-fill, var(--surface-pressed))', mixBlendMode: 'multiply' }),
      }}
    />
  );
}
