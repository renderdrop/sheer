import type { PageSize } from '../../api/render';

/**
 * The one place that turns page space into view space (DESIGN 3.17, 3.20). Text boxes, search hits and link rectangles come from
 * Rust in *page space*: points, origin at the top left of the page's box, y down, **before** the file's `/Rotate`. A page is shown
 * rotated by the file's `/Rotate` and by the view rotation (a quarter turn per step, clockwise, for viewing only), so everything
 * that is placed over a page goes through here: either point by point (`pageToView`), or as one CSS box for a whole layer
 * (`overlayBox`), whose children then stay in page space.
 */

/** A quarter turn clockwise per step. */
export type Rotation = 0 | 90 | 180 | 270;

export const ROTATIONS: readonly Rotation[] = [0, 90, 180, 270];

/** Any angle as one of the four rotations (a multiple of 90 is kept, else it is 0; negative angles turn the other way). */
export function normalizeRotation(degrees: number): Rotation {
  if (!Number.isFinite(degrees)) return 0;
  const quarter = Math.round(degrees / 90);
  const turned = ((quarter % 4) + 4) % 4;
  return (turned * 90) as Rotation;
}

/** `rotation` and a further `by` degrees. */
export function addRotation(rotation: Rotation, by: number): Rotation {
  return normalizeRotation(rotation + by);
}

/** The rotation that applies to page space: the file's `/Rotate` and the view's together. */
export function totalRotation(file: number, view: number): Rotation {
  return normalizeRotation(normalizeRotation(file) + normalizeRotation(view));
}

/** Whether the rotation swaps width and height. */
export function swapsSides(rotation: Rotation): boolean {
  return rotation === 90 || rotation === 270;
}

/** The size of a page after a rotation. */
export function rotateSize(size: PageSize, rotation: Rotation): PageSize {
  return swapsSides(rotation) ? [size[1], size[0]] : size;
}

const rotatedCache = new WeakMap<readonly PageSize[], Map<Rotation, readonly PageSize[]>>();

/**
 * The sizes of a document's pages as the view shows them. The same list for the same input (the layout memoizes on the identity
 * of the list), and the input itself for rotation 0 and 180.
 */
export function rotatedSizes(sizes: readonly PageSize[], rotation: Rotation): readonly PageSize[] {
  if (!swapsSides(rotation)) return sizes;
  let byRotation = rotatedCache.get(sizes);
  if (byRotation === undefined) {
    byRotation = new Map();
    rotatedCache.set(sizes, byRotation);
  }
  let result = byRotation.get(rotation);
  if (result === undefined) {
    result = sizes.map((size) => rotateSize(size, rotation));
    byRotation.set(rotation, result);
  }
  return result;
}

/** The size of a page *before* the file's `/Rotate`, from the size it is drawn at (`get_page_sizes` has the rotation applied). */
export function unrotatedSize(drawn: PageSize, fileRotation: Rotation): PageSize {
  return rotateSize(drawn, fileRotation);
}

export interface Point {
  x: number;
  y: number;
}

/** A rectangle: top left corner and size. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where a point of page space is in the rotated page, in the same unit. `page` is the page's size in page space (unrotated).
 * Rotating a quarter turn clockwise moves the top left corner to the top right.
 */
export function pageToView(point: Point, page: PageSize, rotation: Rotation): Point {
  const [w, h] = page;
  switch (rotation) {
    case 90:
      return { x: h - point.y, y: point.x };
    case 180:
      return { x: w - point.x, y: h - point.y };
    case 270:
      return { x: point.y, y: w - point.x };
    default:
      return { x: point.x, y: point.y };
  }
}

/** The inverse of `pageToView`: a point of the rotated page in page space. */
export function viewToPage(point: Point, page: PageSize, rotation: Rotation): Point {
  const [w, h] = page;
  switch (rotation) {
    case 90:
      return { x: point.y, y: h - point.x };
    case 180:
      return { x: w - point.x, y: h - point.y };
    case 270:
      return { x: w - point.y, y: point.x };
    default:
      return { x: point.x, y: point.y };
  }
}

/** A rectangle of page space in the rotated page: still axis aligned, with the corners that moved. */
export function boxToView(box: Box, page: PageSize, rotation: Rotation): Box {
  const a = pageToView({ x: box.x, y: box.y }, page, rotation);
  const b = pageToView({ x: box.x + box.w, y: box.y + box.h }, page, rotation);
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

/** The inverse of `boxToView`. */
export function boxToPage(box: Box, page: PageSize, rotation: Rotation): Box {
  const a = viewToPage({ x: box.x, y: box.y }, page, rotation);
  const b = viewToPage({ x: box.x + box.w, y: box.y + box.h }, page, rotation);
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

/** The axis aligned box of the corners of a quad (top left, top right, bottom left, bottom right), in page space. */
export function quadBox(quad: readonly Point[]): Box {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const { x, y } of quad) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  if (!Number.isFinite(x0) || !Number.isFinite(y0)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The CSS of a layer that holds page space (children placed in points) over a page. */
export interface OverlayBox {
  left: number;
  top: number;
  width: number;
  height: number;
  transform: string;
}

/**
 * The box of a layer whose children are in page space, in px, inside the page's element. The layer is `page` points wide and
 * high (the unrotated page), scaled by `pxPerPt` and turned by `rotation` about its centre, then centred in the element, which is
 * as large as the rotated page (`boxWidth` x `boxHeight` px). `transform-origin` is the centre (set it with the layer).
 */
export function overlayBox(
  boxWidth: number,
  boxHeight: number,
  page: PageSize,
  pxPerPt: number,
  rotation: Rotation,
): OverlayBox {
  const [w, h] = page;
  const turn = rotation === 0 ? '' : `rotate(${rotation}deg) `;
  return {
    left: (boxWidth - w) / 2,
    top: (boxHeight - h) / 2,
    width: w,
    height: h,
    transform: `${turn}scale(${pxPerPt})`,
  };
}
