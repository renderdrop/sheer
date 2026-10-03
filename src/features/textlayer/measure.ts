/**
 * The width a text would have in the page's font, for stretching a run's span to the width of the glyphs it covers. Measured on a
 * canvas, which is not affected by the transforms the span is under. `null` where there is no canvas to measure with (a test).
 */
const REFERENCE_PX = 100;

let context: CanvasRenderingContext2D | null | undefined;
let family = '';

function contextOrNull(): CanvasRenderingContext2D | null {
  if (context !== undefined) return context;
  context = null;
  // jsdom has no canvas: the feature check keeps it from logging that.
  if (typeof document === 'undefined' || typeof CanvasRenderingContext2D === 'undefined') return null;
  try {
    context = document.createElement('canvas').getContext('2d');
    family = getComputedStyle(document.body).fontFamily;
  } catch {
    context = null;
  }
  return context;
}

/** The width of `text` at a font size of `sizePx`, or `null` if it cannot be measured. */
export function measureTextWidth(text: string, sizePx: number): number | null {
  const ctx = contextOrNull();
  if (ctx === null || !(sizePx > 0)) return null;
  ctx.font = `${REFERENCE_PX}px ${family}`;
  return (ctx.measureText(text).width / REFERENCE_PX) * sizePx;
}
