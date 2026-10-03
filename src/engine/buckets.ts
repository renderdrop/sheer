import { CSS_PX_PER_PT } from '../lib/zoom';

/**
 * Zoom buckets and tiles of the render pipeline (ADR-002 §4, §5). Pure functions, no DOM.
 *
 * A page is rendered at one of a ladder of scales, a quarter of an octave apart, and the browser scales the image by at most
 * 19 % to the exact zoom, so zooming does not render at every step and a cached image serves a range of zooms. Zoom and the
 * display's pixel ratio fold into one number, the device pixels per PDF point `ratio = zoom * CSS_PX_PER_PT * devicePixelRatio`,
 * and the bucket is `b = ceil(4 * log2(ratio))`, rendered at `2^(b / 4)` device pixels per point. A page that is too large at
 * its bucket for one frame is cut into tiles of `TILE_SIZE_PX`.
 *
 * The constants mirror `src-tauri/src/limits.rs`; `buckets.test.ts` reads that file and fails when they drift apart.
 */

/** Smallest and largest bucket the backend accepts (`MIN_BUCKET`, `MAX_BUCKET`). */
export const MIN_BUCKET = -17;
export const MAX_BUCKET = 24;
/** Buckets per doubling of the scale. */
export const BUCKETS_PER_OCTAVE = 4;
/** Side of one tile in pixels, and the most tiles along a side (`TILE_SIZE_PX`, `MAX_TILES_PER_SIDE`). */
export const TILE_SIZE_PX = 1024;
export const MAX_TILES_PER_SIDE = 64;
/** The largest side of a whole page at its bucket, tiled or not (`MAX_PAGE_PIXEL_SIDE`). */
export const MAX_PAGE_PIXEL_SIDE = TILE_SIZE_PX * MAX_TILES_PER_SIDE;
/** The most the backend renders as one frame: a side in pixels and an area (`MAX_RENDER_SIDE_PX`, `MAX_RENDER_PIXELS`). */
export const MAX_FRAME_SIDE_PX = 4096;
export const MAX_FRAME_PIXELS = MAX_FRAME_SIDE_PX * MAX_FRAME_SIDE_PX;
/**
 * Above this many pixels in one side (`MAX_FRAME_SIDE_PX`) or in all (8 million) a page is rendered as tiles (ADR-002 §5): a
 * smaller threshold than the backend's own limit, so no frame gets near the 16 Mpx cap and tiles stay cheap to encode.
 */
export const TILE_ABOVE_PIXELS = 8_000_000;
/** The tiled page's low-resolution underlay is the largest bucket that fits this many pixels, so it renders quickly. */
export const UNDERLAY_MAX_PIXELS = 4_000_000;

/** The most pages the backend takes in one viewport hint, visible and near each (`MAX_VIEWPORT_PAGES`). */
export const MAX_VIEWPORT_PAGES = 64;

/** Floating point noise must not push an exact power of two into the next bucket. */
const BUCKET_EPSILON = 1e-9;

function sanitizeRatio(devicePixelRatio: number): number {
  return Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
}

function clampBucket(bucket: number): number {
  return Math.min(MAX_BUCKET, Math.max(MIN_BUCKET, bucket));
}

/** Device pixels per PDF point of `bucket`: `2^(bucket / 4)`. */
export function bucketScale(bucket: number): number {
  return 2 ** (clampBucket(bucket) / BUCKETS_PER_OCTAVE);
}

/**
 * The bucket to render a page at for `zoom` (1 = 100 % = 96 dpi) on a display with `devicePixelRatio`: the smallest bucket
 * whose scale is at least what is shown, so the image is scaled down, never up. Inside `MIN_BUCKET..=MAX_BUCKET`.
 */
export function bucketFor(zoom: number, devicePixelRatio: number): number {
  const ratio = (Number.isFinite(zoom) && zoom > 0 ? zoom : 1) * CSS_PX_PER_PT * sanitizeRatio(devicePixelRatio);
  // `+ 0` turns the `-0` that the ceiling of a tiny negative number is into 0.
  return clampBucket(Math.ceil(BUCKETS_PER_OCTAVE * Math.log2(ratio) - BUCKET_EPSILON) + 0);
}

/** The size in pixels of a page of `widthPt` x `heightPt` points at `bucket`, rounded up as the backend does. */
export function pixelSizeAt(widthPt: number, heightPt: number, bucket: number): { width: number; height: number } {
  const scale = bucketScale(bucket);
  return { width: Math.max(1, Math.ceil(widthPt * scale)), height: Math.max(1, Math.ceil(heightPt * scale)) };
}

/** How one page is rendered at one zoom: whole, or as tiles over a low-resolution underlay. */
export interface PagePlan {
  /** The bucket rendered. Lower than the one asked for only if the page is so large that the backend would refuse it. */
  bucket: number;
  /** The page's size at `bucket` in pixels: the grid the tiles are cut from. */
  width: number;
  height: number;
  tiled: boolean;
  /** Tiles per row and column; 1 and 1 when the page is not tiled. */
  columns: number;
  rows: number;
  /** For a tiled page, the bucket of the whole-page underlay that shows until a tile arrives; `bucket` otherwise. */
  underlayBucket: number;
}

function fitsFrame(width: number, height: number, maxPixels: number): boolean {
  return width <= MAX_FRAME_SIDE_PX && height <= MAX_FRAME_SIDE_PX && width * height <= maxPixels;
}

/**
 * Plans how to render a page of `widthPt` x `heightPt` points at `bucket` (ADR-002 §5). A page that fits a frame (4096 px a
 * side, 8 Mpx) is one image. A larger one is a grid of 1024 px tiles, and the whole page is rendered once more at a bucket small
 * enough to be quick (the underlay), which is what shows where a tile has not arrived yet.
 */
export function planPage(widthPt: number, heightPt: number, bucket: number): PagePlan {
  let planned = clampBucket(Math.round(bucket));
  let size = pixelSizeAt(widthPt, heightPt, planned);
  // The backend refuses a page that is more than 64 tiles wide or high: draw it at the largest scale it accepts.
  while (planned > MIN_BUCKET && Math.max(size.width, size.height) > MAX_PAGE_PIXEL_SIDE) {
    planned -= 1;
    size = pixelSizeAt(widthPt, heightPt, planned);
  }
  if (fitsFrame(size.width, size.height, TILE_ABOVE_PIXELS)) {
    return { bucket: planned, ...size, tiled: false, columns: 1, rows: 1, underlayBucket: planned };
  }
  let underlay = planned;
  while (underlay > MIN_BUCKET) {
    const small = pixelSizeAt(widthPt, heightPt, underlay);
    if (fitsFrame(small.width, small.height, UNDERLAY_MAX_PIXELS)) break;
    underlay -= 1;
  }
  return {
    bucket: planned,
    ...size,
    tiled: true,
    columns: Math.ceil(size.width / TILE_SIZE_PX),
    rows: Math.ceil(size.height / TILE_SIZE_PX),
    underlayBucket: underlay,
  };
}

/** A rectangle in pixels of the page at its bucket (origin top left, `x1` and `y1` exclusive). */
export interface PixelRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** `[column, row]` of a tile. */
export type TileIndex = readonly [number, number];

/**
 * The tiles of `plan` that `rect` touches, row by row. Empty for a page that is not tiled and for a rectangle with nothing of the
 * page in it: an empty one, one that starts at or after the page's right or bottom edge, and one that ends at or before its top or
 * left edge.
 */
export function tilesIn(plan: PagePlan, rect: PixelRect): TileIndex[] {
  if (!plan.tiled) return [];
  if (rect.x1 <= rect.x0 || rect.y1 <= rect.y0) return [];
  if (rect.x0 >= plan.width || rect.y0 >= plan.height || rect.x1 <= 0 || rect.y1 <= 0) return [];
  const first = (value: number) => Math.floor(value / TILE_SIZE_PX);
  const last = (value: number) => Math.floor((value - 1) / TILE_SIZE_PX);
  const column0 = Math.max(0, first(rect.x0));
  const row0 = Math.max(0, first(rect.y0));
  const column1 = Math.min(plan.columns - 1, last(rect.x1));
  const row1 = Math.min(plan.rows - 1, last(rect.y1));
  const tiles: TileIndex[] = [];
  for (let row = row0; row <= row1; row += 1) {
    for (let column = column0; column <= column1; column += 1) tiles.push([column, row]);
  }
  return tiles;
}

/** The rectangle tile `[column, row]` covers in the page's pixels, cut short at the page's right and bottom edge. */
export function tileRect(plan: PagePlan, tile: TileIndex): PixelRect {
  const x0 = tile[0] * TILE_SIZE_PX;
  const y0 = tile[1] * TILE_SIZE_PX;
  return { x0, y0, x1: Math.min(plan.width, x0 + TILE_SIZE_PX), y1: Math.min(plan.height, y0 + TILE_SIZE_PX) };
}
