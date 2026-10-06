import type { FallbackFace } from '../../api/textEdit';
import type { Rect } from '../../api/wire';
import type { Locale } from '../../i18n';
import type { Box } from '../minibar/placement';

/** The bundled substitutes (ADR-125 report: Arimo, Tinos, Cousine). Family names are proper names, not translated. */
export const FACE_NAME: Record<FallbackFace, string> = { sans: 'Arimo', serif: 'Tinos', mono: 'Cousine' };

/** The most characters the notice lists (DESIGN 3.10 E4). */
export const NOTICE_CHARS = 5;

/** Quote marks per locale (en: "x", de: „x“). */
const QUOTES: Record<Locale, readonly [string, string]> = { en: ['\u201c', '\u201d'], de: ['\u201e', '\u201c'] };

/** Up to five distinct characters, each quoted and joined by the locale's list format, then "…+n" ("„a“, „b“ und „c“ …+3"). */
export function listChars(chars: readonly string[], locale: Locale = 'en'): string {
  const distinct = [...new Set(chars)];
  const [open, close] = QUOTES[locale];
  const quoted = distinct.slice(0, NOTICE_CHARS).map((c) => `${open}${c}${close}`);
  const shown = new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(quoted);
  const more = distinct.length - NOTICE_CHARS;
  return more > 0 ? `${shown} \u2026+${more}` : shown;
}

export interface BoxAnchor {
  left: number;
  transform: string;
  origin: string;
  /** The widest the box may grow (page space) so it stays inside the paragraph window; null = unbounded. */
  maxWidth: number | null;
}

/**
 * Where the edit box is pinned (page space): the same anchor the preview grows from. Left grows rightwards from the line's start,
 * right grows leftwards from its end, centre grows both ways from its middle. `window` clamps the width to the paragraph's edges.
 */
export function boxAnchor(
  align: 'left' | 'center' | 'right',
  box: Rect,
  window: { left: number; right: number } | null,
): BoxAnchor {
  if (align === 'right') {
    return {
      left: box.x + box.w,
      transform: 'translateX(-100%)',
      origin: 'right center',
      maxWidth: window === null ? null : Math.max(box.w, box.x + box.w - window.left),
    };
  }
  if (align === 'center') {
    const c = box.x + box.w / 2;
    return {
      left: c,
      transform: 'translateX(-50%)',
      origin: 'center',
      maxWidth: window === null ? null : Math.max(box.w, 2 * Math.min(c - window.left, window.right - c)),
    };
  }
  return {
    left: box.x,
    transform: '',
    origin: 'left center',
    maxWidth: window === null ? null : Math.max(box.w, window.right - box.x),
  };
}

/**
 * The box's width rules (page space). The box is absolutely pinned at `left` with a translate, so its shrink-to-fit width would be
 * capped by the room right of `left` (a right-aligned line: almost none) and the text would scroll inside. `max-content` makes the
 * width follow the draft; `minWidth` keeps the line's own width; `maxWidth` is the paragraph window's clamp (reflow only).
 */
export function boxWidthStyle(
  box: Rect,
  pin: BoxAnchor,
): { width: 'max-content'; minWidth: number; maxWidth?: number; overflow?: 'hidden' } {
  return {
    width: 'max-content',
    minWidth: box.w,
    ...(pin.maxWidth === null ? {} : { maxWidth: pin.maxWidth, overflow: 'hidden' as const }),
  };
}

/** The page-space left edge of a box of `width` pinned by `pin` (what the browser's translate yields). */
export function boxLeft(pin: BoxAnchor, width: number): number {
  if (pin.transform === 'translateX(-100%)') return pin.left - width;
  if (pin.transform === 'translateX(-50%)') return pin.left - width / 2;
  return pin.left;
}

/**
 * The focus ring's extent (page space): the text's span, grown from the alignment anchor (right-aligned: leftwards, centred: both
 * ways), never smaller than the line's own box and never wider than the window (paragraph edges, or the page edge less the gap).
 */
export function ringSpan(
  align: 'left' | 'center' | 'right',
  box: Rect,
  width: number,
  window: { left: number; right: number },
): { x: number; w: number } {
  const w = Math.max(width, box.w);
  let left = box.x;
  let right = box.x + w;
  if (align === 'right') {
    right = box.x + box.w;
    left = right - w;
  } else if (align === 'center') {
    const c = box.x + box.w / 2;
    left = c - w / 2;
    right = c + w / 2;
  }
  left = Math.max(left, Math.min(window.left, box.x));
  right = Math.min(right, Math.max(window.right, box.x + box.w));
  return { x: left, w: Math.max(0, right - left) };
}

/** A client-pixel rect as a box. */
export const boxOf = (r: Rect): Box => ({ left: r.x, top: r.y, right: r.x + r.w, bottom: r.y + r.h });

/** The smallest rect holding both (client px): the box with its paragraph rule. */
export function unionRect(a: Rect, b: Rect | null): Rect {
  if (b === null) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}
