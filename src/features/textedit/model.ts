import type { FallbackFace } from '../../api/textEdit';
import type { Rect } from '../../api/wire';
import type { Box } from '../minibar/placement';

/** The bundled substitutes (ADR-125 report: Arimo, Tinos, Cousine). Family names are proper names, not translated. */
export const FACE_NAME: Record<FallbackFace, string> = { sans: 'Arimo', serif: 'Tinos', mono: 'Cousine' };

/** The most characters the notice lists (DESIGN 3.10 E4). */
export const NOTICE_CHARS = 5;

/** Up to five distinct characters, then "…" and how many more ("a b c d e …+3"). */
export function listChars(chars: readonly string[]): string {
  const distinct = [...new Set(chars)];
  const shown = distinct.slice(0, NOTICE_CHARS).join(' ');
  const more = distinct.length - NOTICE_CHARS;
  return more > 0 ? `${shown} …+${more}` : shown;
}

/** A client-pixel rect as a box. */
export const boxOf = (r: Rect): Box => ({ left: r.x, top: r.y, right: r.x + r.w, bottom: r.y + r.h });
