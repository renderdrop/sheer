import type { AnnotationDraft, LineEnd, Rgb, Stroke } from '../../../api/annotations';
import type { Point, Quad } from '../../../api/wire';
import type { CreationKind } from '../../../stores/tools';
import { DEFAULT_COLOURS, HIGHLIGHT_OPACITY } from '../../inspector/palette';
import { boxFromPoints, boxInPage, clampToPage, constrainSquare, snapAngle } from './geometry';
import { strokeOutline, toPoints, type Sample } from './ink';

/** The annotation drafts a creation makes (one `createAnnotation` command each), and the style they start from. */

/** The default colours of DESIGN v2 1.4: Solar for highlights and notes (a fill), Ink for everything drawn. */
export const PALETTE = {
  solar: DEFAULT_COLOURS.highlight,
  ink: DEFAULT_COLOURS.ink,
} as const satisfies Record<string, Rgb>;

export interface CreationStyle {
  color: Rgb;
  opacity: number;
  /** Stroke width in points (ink, shapes, lines). */
  width: number;
  fill: Rgb | null;
  dashed: boolean;
  fontSize: number;
  head: LineEnd;
}

/** What a new annotation of a kind looks like until the inspector says otherwise. */
export function defaultStyle(kind: CreationKind): CreationStyle {
  const base: CreationStyle = {
    color: PALETTE.ink,
    opacity: 1,
    width: 2,
    fill: null,
    dashed: false,
    fontSize: 12,
    head: 'none',
  };
  switch (kind) {
    case 'highlight':
      return { ...base, color: PALETTE.solar, opacity: HIGHLIGHT_OPACITY };
    case 'note':
      return { ...base, color: PALETTE.solar };
    case 'freeText':
      return { ...base, color: PALETTE.ink, width: 0 };
    case 'ink':
      return { ...base, color: PALETTE.ink };
    default:
      return base;
  }
}

/** The size of a free text box made by a click, in points. */
export const FREE_TEXT_SIZE = { w: 160, h: 36 } as const;
/** Where a note's icon is anchored relative to the click: the icon is 20 pt, centred on the click. */
export const NOTE_HALF_PT = 10;

export function markupDraft(
  kind: 'highlight' | 'underline' | 'strikeout',
  pageId: number,
  quads: readonly Quad[],
  style: CreationStyle,
): AnnotationDraft | null {
  if (quads.length === 0) return null;
  return { kind, pageId, quads, color: style.color, opacity: style.opacity };
}

export function noteDraft(
  pageId: number,
  at: Point,
  page: readonly [number, number],
  style: CreationStyle,
): AnnotationDraft {
  const p = clampToPage(at, page[0], page[1]);
  return { kind: 'note', pageId, at: p, icon: 'comment', color: style.color, opacity: 1 };
}

/** A free text box from a click (default size) or a drag; the text is empty and the editor fills it. */
export function freeTextDraft(
  pageId: number,
  from: Point,
  to: Point | null,
  page: readonly [number, number],
  style: CreationStyle,
): AnnotationDraft {
  const dragged = to === null ? null : boxFromPoints(from, to);
  const box =
    dragged !== null && dragged.w >= 8 && dragged.h >= 8
      ? boxInPage({ x: dragged.x, y: dragged.y }, dragged.w, dragged.h, page[0], page[1])
      : boxInPage(from, FREE_TEXT_SIZE.w, FREE_TEXT_SIZE.h, page[0], page[1]);
  return {
    kind: 'freeText',
    pageId,
    box,
    lines: [],
    fontSize: style.fontSize,
    fill: style.fill,
    borderWidth: 0,
    color: style.color,
    opacity: 1,
  };
}

/**
 * The end of a shape drag: Shift makes a rectangle or ellipse square, a line or arrow a multiple of 45 degrees. With `page` the
 * result stays inside the page by shrinking the shape (not by clamping a corner, which would break the square or the angle).
 */
export function shapeEnd(
  kind: 'rect' | 'ellipse' | 'line' | 'arrow',
  from: Point,
  to: Point,
  shift: boolean,
  page?: readonly [number, number],
): Point {
  if (!shift) return page === undefined ? to : clampToPage(to, page[0], page[1]);
  const free = kind === 'line' || kind === 'arrow' ? snapAngle(from, to) : constrainSquare(from, to);
  if (page === undefined) return free;
  const dx = free.x - from.x;
  const dy = free.y - from.y;
  const roomX = dx < 0 ? from.x : page[0] - from.x;
  const roomY = dy < 0 ? from.y : page[1] - from.y;
  const scale = Math.max(0, Math.min(1, dx === 0 ? 1 : roomX / Math.abs(dx), dy === 0 ? 1 : roomY / Math.abs(dy)));
  return { x: from.x + dx * scale, y: from.y + dy * scale };
}

export function shapeDraft(
  kind: 'rect' | 'ellipse' | 'line' | 'arrow',
  pageId: number,
  from: Point,
  to: Point,
  page: readonly [number, number],
  style: CreationStyle,
): AnnotationDraft {
  const a = clampToPage(from, page[0], page[1]);
  const b = clampToPage(to, page[0], page[1]);
  if (kind === 'line' || kind === 'arrow') {
    return {
      kind: 'line',
      pageId,
      from: a,
      to: b,
      width: style.width,
      head: kind === 'arrow' ? (style.head === 'none' ? 'closedArrow' : style.head) : 'none', // the head is the tip, at `to`
      tail: 'none',
      color: style.color,
      opacity: style.opacity,
    };
  }
  return {
    kind,
    pageId,
    box: boxFromPoints(a, b),
    width: style.width,
    fill: style.fill,
    dashed: style.dashed,
    color: style.color,
    opacity: style.opacity,
  };
}

/** One ink annotation from finished (already smoothed) strokes. */
export function inkDraft(
  pageId: number,
  strokes: readonly (readonly Sample[])[],
  style: CreationStyle,
): AnnotationDraft | null {
  const made: Stroke[] = strokes
    .filter((s) => s.length > 0)
    .map((samples) => ({ points: toPoints(samples), outline: strokeOutline(samples, style.width) }));
  if (made.length === 0) return null;
  return { kind: 'ink', pageId, strokes: made, width: style.width, color: style.color, opacity: style.opacity };
}
