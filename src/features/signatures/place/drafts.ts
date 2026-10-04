import type { AnnotationDraft, MarkGlyph, Rgb } from '../../../api/annotations';
import { MAX_SIGNATURE_ASPECT, MIN_SIGNATURE_ASPECT } from '../../../api/annotations';
import type { SignatureRole } from '../../../api/library';
import type { Point, Rect } from '../../../api/wire';
import { boxInPage } from '../../annotations/create/geometry';
import { normalizeAngle, rotatedBounds } from '../../annotations/selection/geometry';
import { SIGNATURE_PALETTE } from '../../inspector/palette';
import type { PlaceItem } from './store';

/** The sizes and drafts of what the Sign tool places (DESIGN 3.34), all in page space (points). */

/** Heights of a signature and of initials, a mark's side, and the type size of Text and Date. */
export const SIGNATURE_HEIGHT_PT = 36;
export const INITIALS_HEIGHT_PT = 24;
export const MARK_SIDE_PT = 12;
export const TEXT_SIZE_PT = 12;
/** The width of a free text box that Text places, and the room around a date's characters. */
export const TEXT_BOX_WIDTH_PT = 160;
const TEXT_PAD_PT = 2;
const LINE_HEIGHT = 1.2;
const CHAR_WIDTH_SHARE = 0.6;

const BLACK: Rgb = [0, 0, 0];
/** Ink (`--stroke-ink`) and the one blue of the interface (`--ink-signature`), the two inks of a drawn or typed signature. */
const INK: Rgb = SIGNATURE_PALETTE[0]?.rgb ?? BLACK;
const SIGNATURE_BLUE: Rgb = SIGNATURE_PALETTE[1]?.rgb ?? BLACK;

/** The size of an item's box, in points. A signature is never wider than the page (it shrinks, the aspect kept). */
export function itemSize(item: PlaceItem, page: readonly [number, number], dateText = ''): { w: number; h: number } {
  switch (item.type) {
    case 'signature': {
      const aspect = Math.min(Math.max(item.aspect, MIN_SIGNATURE_ASPECT), MAX_SIGNATURE_ASPECT);
      const h = item.role === 'initials' ? INITIALS_HEIGHT_PT : SIGNATURE_HEIGHT_PT;
      const scale = Math.min(1, page[0] / (h * aspect), page[1] / h);
      return { w: h * aspect * scale, h: h * scale };
    }
    case 'mark':
      return { w: MARK_SIDE_PT, h: MARK_SIDE_PT };
    case 'text':
      return { w: TEXT_BOX_WIDTH_PT, h: TEXT_SIZE_PT * LINE_HEIGHT + 2 * TEXT_PAD_PT };
    case 'date':
      return {
        w: dateText.length * TEXT_SIZE_PT * CHAR_WIDTH_SHARE + 2 * TEXT_PAD_PT,
        h: TEXT_SIZE_PT * LINE_HEIGHT + 2 * TEXT_PAD_PT,
      };
  }
}

/**
 * The turn that makes an item stand upright on the screen when the page's page space is shown turned `rotation` degrees clockwise
 * (the file's `/Rotate` and the view rotation together): the item is turned against it (ADR-105). In (-180, 180].
 */
export function uprightAngle(rotation: number): number {
  return normalizeAngle(-rotation);
}

/**
 * The box of the given size centred on `at`, moved to lie inside the page. A box that is turned `angle` degrees is kept inside with its
 * turned bounds, the size before the turn is returned.
 */
export function centredBox(
  at: Point,
  size: { w: number; h: number },
  page: readonly [number, number],
  angle = 0,
): Rect {
  if (angle !== 0) {
    const bounds = rotatedBounds({ x: 0, y: 0, ...size }, angle);
    const keep = (centre: number, span: number, side: number) =>
      span >= side ? side / 2 : Math.min(Math.max(centre, span / 2), side - span / 2);
    const cx = keep(at.x, bounds.w, page[0]);
    const cy = keep(at.y, bounds.h, page[1]);
    return { x: cx - size.w / 2, y: cy - size.h / 2, w: size.w, h: size.h };
  }
  return boxInPage({ x: at.x - size.w / 2, y: at.y - size.h / 2 }, size.w, size.h, page[0], page[1]);
}

/** Today's date as short free text in the system's region (the webview's locale is the OS's; the UI language is not used). */
export function dateText(now: Date = new Date(), style: 'short' | 'medium' | 'long' = 'medium'): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: style }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** A `freeText` draft with fixed text (Date) or empty text for the editor (Text). */
export function textDraft(pageId: number, box: Rect, lines: readonly string[]): AnnotationDraft {
  return {
    kind: 'freeText',
    pageId,
    box,
    lines,
    fontSize: TEXT_SIZE_PT,
    fill: null,
    borderWidth: 0,
    color: BLACK,
    opacity: 1,
  };
}

export function markDraft(pageId: number, box: Rect, glyph: MarkGlyph, angle = 0): AnnotationDraft {
  return { kind: 'mark', pageId, box, glyph, color: BLACK, opacity: 1, ...(angle === 0 ? {} : { angle }) };
}

export function signatureDraft(
  pageId: number,
  box: Rect,
  role: SignatureRole,
  art: { assetId: number; aspect: number },
  ink: 'ink' | 'signature' = 'ink',
  angle = 0,
): AnnotationDraft {
  return {
    kind: 'signature',
    pageId,
    box,
    role,
    art: { type: 'asset', assetId: art.assetId, aspect: art.aspect },
    color: ink === 'signature' ? SIGNATURE_BLUE : INK,
    opacity: 1,
    ...(angle === 0 ? {} : { angle }),
  };
}
