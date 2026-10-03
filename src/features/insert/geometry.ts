import { MIN_CONTENT_BOX_PT } from '../../api/annotations';
import type { PageSize } from '../../api/render';
import type { Point, Rect } from '../../api/wire';
import { boxInPage, isDrag } from '../annotations/create/geometry';
import { resizeRect, type HandleId } from '../annotations/selection/geometry';
import { viewToPage, type Rotation } from '../viewer/transform';

/** Pure geometry of the insert tools (DESIGN 3.36), in page space (points, before any rotation). */

/** A new text box is this wide when it is placed with a click, and as high as one line of the default size at least. */
export const DEFAULT_TEXT_WIDTH_PT = 160;
/** The backend's line height in times the font size (`LINE_HEIGHT` in content/text.rs). */
export const LINE_HEIGHT = 1.2;
/** A new image is this share of the page width wide (DESIGN 3.36). */
export const IMAGE_PAGE_SHARE = 0.5;
/** The step of an arrow key in points; with Shift ten times it. */
export const NUDGE_PT = 1;
export const BIG_NUDGE_PT = 10;

/** The height of `lines` lines of `fontSize`. */
export function textHeight(lines: number, fontSize: number): number {
  return Math.max(1, lines) * fontSize * LINE_HEIGHT;
}

/** The box of a text box made by a click at `at` (top left there) or by a drag from `from` to `to` (the drag sets the width). */
export function newTextBoxRect(from: Point, to: Point, fontSize: number, page: PageSize): Rect {
  const height = textHeight(1, fontSize);
  if (!isDrag(from, to)) return boxInPage(from, DEFAULT_TEXT_WIDTH_PT, height, page[0], page[1]);
  const width = Math.max(MIN_CONTENT_BOX_PT, Math.abs(to.x - from.x));
  return boxInPage({ x: Math.min(from.x, to.x), y: from.y }, width, height, page[0], page[1]);
}

/** An image at its default size (half the page width, natural aspect, at most the page height) centred on `at`, kept on the page. */
export function defaultImageRect(aspect: number, at: Point, page: PageSize): Rect {
  let w = page[0] * IMAGE_PAGE_SHARE;
  let h = w / aspect;
  if (h > page[1]) {
    h = page[1];
    w = h * aspect;
  }
  return boxInPage({ x: at.x - w / 2, y: at.y - h / 2 }, w, h, page[0], page[1]);
}

/** An image drawn by a drag from `from` to `to`: with `keepAspect` the height follows the width. */
export function imageRectFromDrag(from: Point, to: Point, aspect: number, keepAspect: boolean, page: PageSize): Rect {
  const w = Math.max(MIN_CONTENT_BOX_PT, Math.abs(to.x - from.x));
  const h = keepAspect ? w / aspect : Math.max(MIN_CONTENT_BOX_PT, Math.abs(to.y - from.y));
  const x = to.x < from.x ? from.x - w : from.x;
  const y = to.y < from.y ? from.y - h : from.y;
  return boxInPage({ x, y }, w, h, page[0], page[1]);
}

/** A vector of the rotated page (screen, in points) as a vector of page space. */
export function viewDeltaToPage(dx: number, dy: number, page: PageSize, rotation: Rotation): Point {
  const origin = viewToPage({ x: 0, y: 0 }, page, rotation);
  const moved = viewToPage({ x: dx, y: dy }, page, rotation);
  return { x: moved.x - origin.x, y: moved.y - origin.y };
}

/** The handles of a text box (its width) and an image (corners; the sides too when the aspect is not locked). */
export function handlesFor(kind: 'textBox' | 'image', keepAspect: boolean): readonly HandleId[] {
  if (kind === 'textBox') return ['w', 'e'];
  return keepAspect ? ['nw', 'ne', 'se', 'sw'] : ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
}

/** A box moved by (`dx`, `dy`), limited so that it stays on the page. */
export function movedRect(box: Rect, dx: number, dy: number, page: PageSize): Rect {
  const x = Math.min(Math.max(box.x + dx, 0), Math.max(0, page[0] - box.w));
  const y = Math.min(Math.max(box.y + dy, 0), Math.max(0, page[1] - box.h));
  return { ...box, x, y };
}

/**
 * A box with one handle dragged by (`dx`, `dy`). A text box only changes its width (its height follows the text); an image
 * keeps its aspect at the corners when `keepAspect`; the side handles of an unlocked image are free.
 */
export function resizedRect(
  kind: 'textBox' | 'image',
  box: Rect,
  handle: HandleId,
  dx: number,
  dy: number,
  keepAspect: boolean,
  page: PageSize,
): Rect {
  if (kind === 'textBox') {
    if (handle !== 'e' && handle !== 'w') return box;
    return { ...resizeRect(box, handle, dx, 0, false, page), y: box.y, h: box.h };
  }
  return resizeRect(box, handle, dx, dy, keepAspect, page);
}

export function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/** Where a handle sits on a box. */
export function handleAt(box: Rect, handle: HandleId): Point {
  const x = handle.includes('w') ? box.x : handle.includes('e') ? box.x + box.w : box.x + box.w / 2;
  const y = handle.includes('n') ? box.y : handle.includes('s') ? box.y + box.h : box.y + box.h / 2;
  return { x, y };
}
