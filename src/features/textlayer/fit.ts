/**
 * Fitting a run's span to the width PDFium reports for it. A `scaleX` transform would do, but Chromium hit-tests the caret with the
 * untransformed glyph advances, so a drag past a stretched or squeezed run ends short by the scale factor. Letter spacing changes the
 * layout itself, so the caret, the selection and the hit areas all agree with what is drawn.
 */

/** Narrower or wider than the glyphs by less than this share (of the natural width) is left as it is. */
export const FIT_TOLERANCE = 0.01;
const SPACING_LIMIT_EM = 2;

/**
 * The letter spacing in px that makes a run of `chars` UTF-16 units, naturally `natural` px wide, `target` px wide (the spacing is
 * added after every unit, the last one included). 0 when it fits already or cannot be measured.
 */
export function letterSpacingFor(natural: number | null, target: number, chars: number, sizePx: number): number {
  if (natural === null || !(natural > 0) || !(target > 0) || chars < 1) return 0;
  if (Math.abs(target / natural - 1) < FIT_TOLERANCE) return 0;
  const limit = SPACING_LIMIT_EM * sizePx;
  return Math.max(-limit, Math.min(limit, (target - natural) / chars));
}
