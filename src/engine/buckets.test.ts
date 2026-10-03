import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { MAX_PAGES, MAX_PAGE_SIDE_PT } from '../api/render';
import { CSS_PX_PER_PT, MAX_ZOOM, MIN_ZOOM } from '../lib/zoom';
import {
  BUCKETS_PER_OCTAVE,
  MAX_BUCKET,
  MAX_FRAME_PIXELS,
  MAX_FRAME_SIDE_PX,
  MAX_PAGE_PIXEL_SIDE,
  MAX_VIEWPORT_PAGES,
  MAX_TILES_PER_SIDE,
  MIN_BUCKET,
  TILE_ABOVE_PIXELS,
  TILE_SIZE_PX,
  UNDERLAY_MAX_PIXELS,
  bucketFor,
  bucketScale,
  pixelSizeAt,
  planPage,
  tileRect,
  tilesIn,
  type PagePlan,
} from './buckets';

/** The numeric constants of src-tauri/src/limits.rs, by name. */
function rustConstants(): Map<string, number> {
  const source = readFileSync(new URL('../../src-tauri/src/limits.rs', import.meta.url), 'utf8');
  const found = new Map<string, number>();
  for (const [, name, expression] of source.matchAll(/^pub const (\w+): (?:u32|u64|i16|f32|f64|usize) = ([^;]+);/gm)) {
    if (name === undefined || expression === undefined) continue;
    // `4096 * 4096` and `TILE_SIZE_PX * MAX_TILES_PER_SIDE` are the only expressions; both are products of numbers or names.
    const value = expression
      .split('*')
      .map((factor) => factor.trim())
      .map((factor) => (/^-?[\d_.]+$/.test(factor) ? Number(factor.replaceAll('_', '')) : found.get(factor)))
      .reduce<number | undefined>(
        (product, factor) => (product === undefined || factor === undefined ? undefined : product * factor),
        1,
      );
    if (value !== undefined) found.set(name, value);
  }
  return found;
}

describe('the constants mirror the backend (src-tauri/src/limits.rs)', () => {
  const rust = rustConstants();

  it('has every limit this file mirrors, with the same value', () => {
    expect(rust.get('MIN_BUCKET')).toBe(MIN_BUCKET);
    expect(rust.get('MAX_BUCKET')).toBe(MAX_BUCKET);
    expect(rust.get('BUCKETS_PER_OCTAVE')).toBe(BUCKETS_PER_OCTAVE);
    expect(rust.get('TILE_SIZE_PX')).toBe(TILE_SIZE_PX);
    expect(rust.get('MAX_TILES_PER_SIDE')).toBe(MAX_TILES_PER_SIDE);
    expect(rust.get('MAX_PAGE_PIXEL_SIDE')).toBe(MAX_PAGE_PIXEL_SIDE);
    expect(rust.get('MAX_RENDER_SIDE_PX')).toBe(MAX_FRAME_SIDE_PX);
    expect(rust.get('MAX_RENDER_PIXELS')).toBe(MAX_FRAME_PIXELS);
    expect(rust.get('MAX_VIEWPORT_PAGES')).toBe(MAX_VIEWPORT_PAGES);
    expect(rust.get('MAX_PAGES')).toBe(MAX_PAGES);
    expect(rust.get('MAX_PAGE_SIDE_PT')).toBe(MAX_PAGE_SIDE_PT);
  });

  it('keeps every frame the UI asks for under the backend frame limits', () => {
    expect(TILE_ABOVE_PIXELS).toBeLessThanOrEqual(MAX_FRAME_PIXELS);
    expect(TILE_SIZE_PX).toBeLessThanOrEqual(MAX_FRAME_SIDE_PX);
    expect(UNDERLAY_MAX_PIXELS).toBeLessThan(TILE_ABOVE_PIXELS);
  });
});

describe('bucketFor', () => {
  it('is the quarter-octave ceiling of the device pixels per point', () => {
    // 100 % on a 96 dpi screen is 4/3 px per point: log2 = 0.415, times 4 = 1.66, so bucket 2 (1.41 px per point).
    expect(bucketFor(1, 1)).toBe(2);
    expect(bucketScale(2)).toBeCloseTo(Math.SQRT2);
    // A retina display needs twice the pixels: four buckets (one octave) more.
    expect(bucketFor(1, 2)).toBe(bucketFor(1, 1) + BUCKETS_PER_OCTAVE);
    // Zooming by a factor of 2 is one octave too.
    expect(bucketFor(2, 1)).toBe(bucketFor(1, 1) + BUCKETS_PER_OCTAVE);
  });

  it('never rounds down: the image is scaled down by the browser, not up', () => {
    for (const zoom of [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4]) {
      for (const ratio of [1, 1.25, 1.5, 2, 3]) {
        const wanted = zoom * CSS_PX_PER_PT * ratio;
        const bucket = bucketFor(zoom, ratio);
        const scale = bucketScale(bucket);
        expect(scale, `${zoom} x ${ratio}`).toBeGreaterThanOrEqual(wanted - 1e-9);
        // And by at most one step of the ladder: a factor of 2^(1/4), a 19 % reduction at most.
        expect(scale / wanted, `${zoom} x ${ratio}`).toBeLessThan(2 ** (1 / BUCKETS_PER_OCTAVE) + 1e-9);
      }
    }
  });

  it('puts exact powers of two into their own bucket, not the next one', () => {
    // 0.75 * 4/3 = 1 px per point: bucket 0 exactly.
    expect(bucketFor(0.75, 1)).toBe(0);
    expect(bucketFor(1.5, 1)).toBe(4);
    expect(bucketFor(3, 1)).toBe(8);
  });

  it('stays inside what the backend accepts for every zoom and display the UI offers', () => {
    for (const ratio of [0.5, 1, 1.5, 2, 3, 4]) {
      expect(bucketFor(MIN_ZOOM, ratio)).toBeGreaterThanOrEqual(MIN_BUCKET);
      expect(bucketFor(MAX_ZOOM, ratio)).toBeLessThanOrEqual(MAX_BUCKET);
    }
    expect(bucketFor(1e-9, 1)).toBe(MIN_BUCKET);
    expect(bucketFor(1e9, 1)).toBe(MAX_BUCKET);
  });

  it('falls back to a ratio of 1 for a bad pixel ratio, and to 100 % for a bad zoom', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(bucketFor(1, bad)).toBe(bucketFor(1, 1));
      expect(bucketFor(bad, 1)).toBe(bucketFor(1, 1));
    }
  });

  it('is one number for zoom and display together: a zoom on one display and half of it on one twice as dense share an image', () => {
    expect(bucketFor(0.5, 2)).toBe(bucketFor(1, 1));
    expect(bucketFor(1, 1.5)).toBe(bucketFor(1.5, 1));
  });
});

describe('bucketScale', () => {
  it('is 2^(bucket / 4)', () => {
    expect(bucketScale(0)).toBe(1);
    expect(bucketScale(4)).toBe(2);
    expect(bucketScale(-4)).toBe(0.5);
    expect(bucketScale(MAX_BUCKET)).toBe(64);
  });

  it('is clamped to the buckets the backend accepts', () => {
    expect(bucketScale(100)).toBe(bucketScale(MAX_BUCKET));
    expect(bucketScale(-100)).toBe(bucketScale(MIN_BUCKET));
  });
});

describe('pixelSizeAt', () => {
  it('rounds up, as the backend does, and is never empty', () => {
    expect(pixelSizeAt(612, 792, 0)).toEqual({ width: 612, height: 792 });
    expect(pixelSizeAt(200.5, 100.2, 0)).toEqual({ width: 201, height: 101 });
    expect(pixelSizeAt(1, 1, MIN_BUCKET)).toEqual({ width: 1, height: 1 });
  });
});

describe('planPage', () => {
  it('renders a page that fits a frame as one image', () => {
    const plan = planPage(612, 792, bucketFor(1, 1));
    expect(plan).toMatchObject({ tiled: false, columns: 1, rows: 1, bucket: 2, underlayBucket: 2 });
    expect(plan.width).toBe(Math.ceil(612 * Math.SQRT2));
  });

  it('tiles a page above 4096 px a side', () => {
    // 612 x 792 pt at 8 px per point (bucket 12): 4896 x 6336, a grid of 5 x 7 tiles.
    const plan = planPage(612, 792, 12);
    expect(plan).toMatchObject({ tiled: true, width: 4896, height: 6336, columns: 5, rows: 7, bucket: 12 });
  });

  it('tiles a page above 8 Mpx even when every side is within a frame', () => {
    // 2900 x 2900 px is 8.4 Mpx: one frame could hold it (the backend's limit is 16 Mpx) but the plan keeps frames below 8.
    expect(planPage(2800, 2800, 0)).toMatchObject({ tiled: false });
    expect(planPage(2900, 2900, 0)).toMatchObject({ tiled: true });
    expect(planPage(4096, 1000, 0)).toMatchObject({ tiled: false });
    expect(planPage(4097, 100, 0)).toMatchObject({ tiled: true });
  });

  it('gives a tiled page a low resolution underlay that renders quickly and is itself one frame', () => {
    const plan = planPage(612, 792, 12);
    const underlay = pixelSizeAt(612, 792, plan.underlayBucket);
    expect(plan.underlayBucket).toBeLessThan(plan.bucket);
    expect(underlay.width * underlay.height).toBeLessThanOrEqual(UNDERLAY_MAX_PIXELS);
    // The largest bucket that fits: the next one is over the budget.
    const next = pixelSizeAt(612, 792, plan.underlayBucket + 1);
    expect(next.width * next.height).toBeGreaterThan(UNDERLAY_MAX_PIXELS);
  });

  it('draws a page that would need more than 64 tiles a side at the largest scale the backend accepts', () => {
    // A 14400 pt page at 4.4 px per point is 63 360 px; at bucket 10 (5.66) it would be 81 000: too many tiles.
    const plan = planPage(14_400, 100, 10);
    expect(plan.bucket).toBeLessThan(10);
    expect(plan.width).toBeLessThanOrEqual(MAX_PAGE_PIXEL_SIDE);
    expect(plan.columns).toBeLessThanOrEqual(MAX_TILES_PER_SIDE);
    expect(planPage(14_400, 100, plan.bucket + 1).bucket).toBeLessThanOrEqual(plan.bucket + 1);
    expect(pixelSizeAt(14_400, 100, plan.bucket + 1).width).toBeGreaterThan(MAX_PAGE_PIXEL_SIDE);
  });

  it('never plans below the smallest bucket, and clamps the requested one', () => {
    expect(planPage(612, 792, -100).bucket).toBe(MIN_BUCKET);
    expect(planPage(10, 10, 100).bucket).toBeLessThanOrEqual(MAX_BUCKET);
  });
});

describe('tiles of a plan', () => {
  const plan = planPage(612, 792, 12); // 4896 x 6336, 5 x 7

  it('lists the tiles a rectangle touches, row by row', () => {
    expect(tilesIn(plan, { x0: 0, y0: 0, x1: 10, y1: 10 })).toEqual([[0, 0]]);
    expect(tilesIn(plan, { x0: 1000, y0: 1000, x1: 1100, y1: 1100 })).toEqual([
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ]);
  });

  it('treats the far edge as exclusive: a rectangle ending on a tile boundary does not touch the next tile', () => {
    expect(tilesIn(plan, { x0: 0, y0: 0, x1: 1024, y1: 1024 })).toEqual([[0, 0]]);
    expect(tilesIn(plan, { x0: 0, y0: 0, x1: 1025, y1: 1024 })).toEqual([
      [0, 0],
      [1, 0],
    ]);
  });

  it('keeps to the grid: a rectangle beyond the page or before it has no more tiles than the page has', () => {
    expect(tilesIn(plan, { x0: -5000, y0: -5000, x1: 99_999, y1: 99_999 })).toHaveLength(5 * 7);
    expect(tilesIn(plan, { x0: -500, y0: -500, x1: -100, y1: -100 })).toEqual([]);
    expect(tilesIn(plan, { x0: 6000, y0: 0, x1: 7000, y1: 100 })).toEqual([]);
  });

  it('has no tile for a rectangle that starts at or after the page edge, even inside the last tile column or row', () => {
    // The page is 4896 x 6336 px: its last column is 4096..4896, its last row 6144..6336.
    expect(plan.width).toBe(4896);
    expect(plan.height).toBe(6336);
    expect(tilesIn(plan, { x0: 4895, y0: 0, x1: 5000, y1: 100 })).toEqual([[4, 0]]);
    expect(tilesIn(plan, { x0: 4896, y0: 0, x1: 5000, y1: 100 })).toEqual([]);
    expect(tilesIn(plan, { x0: 5000, y0: 0, x1: 6000, y1: 100 })).toEqual([]);
    expect(tilesIn(plan, { x0: 0, y0: 6335, x1: 100, y1: 7000 })).toEqual([[0, 6]]);
    expect(tilesIn(plan, { x0: 0, y0: 6336, x1: 100, y1: 7000 })).toEqual([]);
    expect(tilesIn(plan, { x0: 0, y0: 6400, x1: 100, y1: 7000 })).toEqual([]);
    expect(tilesIn(plan, { x0: 4900, y0: 6400, x1: 9000, y1: 9000 })).toEqual([]);
  });

  it('has no tile for a rectangle that ends at or before the page origin, or that is empty', () => {
    expect(tilesIn(plan, { x0: -100, y0: 0, x1: 1, y1: 100 })).toEqual([[0, 0]]);
    expect(tilesIn(plan, { x0: -100, y0: 0, x1: 0, y1: 100 })).toEqual([]);
    expect(tilesIn(plan, { x0: 0, y0: -100, x1: 100, y1: 0 })).toEqual([]);
    expect(tilesIn(plan, { x0: 100, y0: 100, x1: 100, y1: 200 })).toEqual([]);
    expect(tilesIn(plan, { x0: 100, y0: 100, x1: 200, y1: 100 })).toEqual([]);
    expect(tilesIn(plan, { x0: 200, y0: 0, x1: 100, y1: 100 })).toEqual([]);
  });

  it('has none for a page that is not tiled', () => {
    expect(tilesIn(planPage(612, 792, 2), { x0: 0, y0: 0, x1: 100, y1: 100 })).toEqual([]);
  });

  it('knows the rectangle of a tile, cut short at the right and bottom edge', () => {
    expect(tileRect(plan, [0, 0])).toEqual({ x0: 0, y0: 0, x1: 1024, y1: 1024 });
    expect(tileRect(plan, [4, 6])).toEqual({ x0: 4096, y0: 6144, x1: 4896, y1: 6336 });
  });
});

describe('the tiles of a page cover it exactly: no gap, no overlap, whatever the size', () => {
  /** Page size in points and bucket; the plan has to come out tiled, or the case tests nothing. */
  const cases: readonly { name: string; widthPt: number; heightPt: number; bucket: number }[] = [
    { name: 'an odd size', widthPt: 612, heightPt: 792, bucket: 12 },
    { name: 'an exact multiple of the tile size', widthPt: 2048, heightPt: 1024, bucket: 8 }, // 8192 x 4096 px
    { name: 'one pixel past a multiple', widthPt: 2048.25, heightPt: 1024.25, bucket: 8 }, // 8193 x 4097 px
    { name: 'a sliver one pixel wide on the right', widthPt: 4097, heightPt: 1, bucket: 0 }, // 4097 x 1 px
    { name: 'a sliver one pixel high at the bottom', widthPt: 1, heightPt: 4097, bucket: 0 },
    { name: 'a page tiled for its area alone', widthPt: 2900, heightPt: 2900, bucket: 0 }, // 8.41 Mpx, each side within a frame
    { name: 'a fractional point size', widthPt: 595.276, heightPt: 841.89, bucket: 14 },
    { name: 'the widest page the backend takes', widthPt: 16_384, heightPt: 1, bucket: 8 }, // 65 536 px: 64 tiles
  ];

  const wholePage = (plan: PagePlan) => ({ x0: 0, y0: 0, x1: plan.width, y1: plan.height });

  for (const { name, widthPt, heightPt, bucket } of cases) {
    it(`${name}: ${widthPt} x ${heightPt} pt at bucket ${bucket}`, () => {
      const plan = planPage(widthPt, heightPt, bucket);
      expect(plan.tiled).toBe(true);
      expect(plan.columns).toBe(Math.ceil(plan.width / TILE_SIZE_PX));
      expect(plan.rows).toBe(Math.ceil(plan.height / TILE_SIZE_PX));
      expect(plan.columns).toBeLessThanOrEqual(MAX_TILES_PER_SIDE);
      expect(plan.rows).toBeLessThanOrEqual(MAX_TILES_PER_SIDE);

      const tiles = tilesIn(plan, wholePage(plan));
      // Every tile of the grid exactly once.
      expect(tiles).toHaveLength(plan.columns * plan.rows);
      expect(new Set(tiles.map(([column, row]) => `${column},${row}`)).size).toBe(tiles.length);

      let area = 0;
      for (const tile of tiles) {
        const rect = tileRect(plan, tile);
        const width = rect.x1 - rect.x0;
        const height = rect.y1 - rect.y0;
        // Inside the page, never empty, never larger than a tile.
        expect(rect.x0).toBeGreaterThanOrEqual(0);
        expect(rect.y0).toBeGreaterThanOrEqual(0);
        expect(rect.x1).toBeLessThanOrEqual(plan.width);
        expect(rect.y1).toBeLessThanOrEqual(plan.height);
        expect(width).toBeGreaterThanOrEqual(1);
        expect(height).toBeGreaterThanOrEqual(1);
        expect(width).toBeLessThanOrEqual(TILE_SIZE_PX);
        expect(height).toBeLessThanOrEqual(TILE_SIZE_PX);
        area += width * height;
      }
      // The areas add up to the page's own: with every tile inside the page, that leaves no gap and no overlap.
      expect(area).toBe(plan.width * plan.height);

      // Neighbours abut: each column starts where the one before it ended, the first at 0 and the last at the page's edge.
      for (let column = 0; column < plan.columns; column += 1) {
        const rect = tileRect(plan, [column, 0]);
        expect(rect.x0).toBe(column === 0 ? 0 : tileRect(plan, [column - 1, 0]).x1);
      }
      for (let row = 0; row < plan.rows; row += 1) {
        const rect = tileRect(plan, [0, row]);
        expect(rect.y0).toBe(row === 0 ? 0 : tileRect(plan, [0, row - 1]).y1);
      }
      expect(tileRect(plan, [plan.columns - 1, plan.rows - 1])).toMatchObject({ x1: plan.width, y1: plan.height });

      // No tile exists beyond the grid: the backend answers `invalid_argument` for one.
      expect(tileRect(plan, [plan.columns, 0]).x0).toBeGreaterThanOrEqual(plan.width);
      expect(tileRect(plan, [0, plan.rows]).y0).toBeGreaterThanOrEqual(plan.height);
    });
  }

  it('the last tile of an exact multiple is full, and one pixel more adds a sliver of one pixel', () => {
    const exact = planPage(2048, 1024, 8);
    expect([exact.width, exact.height, exact.columns, exact.rows]).toEqual([8192, 4096, 8, 4]);
    expect(tileRect(exact, [7, 3])).toEqual({ x0: 7168, y0: 3072, x1: 8192, y1: 4096 });
    const over = planPage(2048.25, 1024.25, 8);
    expect([over.width, over.height, over.columns, over.rows]).toEqual([8193, 4097, 9, 5]);
    expect(tileRect(over, [8, 4])).toEqual({ x0: 8192, y0: 4096, x1: 8193, y1: 4097 });
  });

  it('a rectangle is covered by the tiles it is given: every pixel of it is in one of them, none outside it is asked for', () => {
    const plan = planPage(612, 792, 12); // 4896 x 6336
    let seed = 11;
    const random = (limit: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return Math.floor((seed / 2 ** 31) * limit);
    };
    for (let trial = 0; trial < 300; trial += 1) {
      const x0 = random(plan.width);
      const y0 = random(plan.height);
      const rect = { x0, y0, x1: x0 + 1 + random(plan.width - x0), y1: y0 + 1 + random(plan.height - y0) };
      const asked = tilesIn(plan, rect);
      const askedKeys = new Set(asked.map(([column, row]) => `${column},${row}`));
      // No tile that the rectangle does not touch.
      for (const tile of asked) {
        const t = tileRect(plan, tile);
        expect(t.x0 < rect.x1 && rect.x0 < t.x1 && t.y0 < rect.y1 && rect.y0 < t.y1, `${JSON.stringify(rect)}`).toBe(
          true,
        );
      }
      // Every corner and every tile boundary inside the rectangle lies in a tile that was asked for.
      const xs = [rect.x0, rect.x1 - 1];
      const ys = [rect.y0, rect.y1 - 1];
      for (let x = Math.ceil(rect.x0 / TILE_SIZE_PX) * TILE_SIZE_PX; x < rect.x1; x += TILE_SIZE_PX) xs.push(x - 1, x);
      for (let y = Math.ceil(rect.y0 / TILE_SIZE_PX) * TILE_SIZE_PX; y < rect.y1; y += TILE_SIZE_PX) ys.push(y - 1, y);
      for (const x of xs) {
        for (const y of ys) {
          if (x < rect.x0 || x >= rect.x1 || y < rect.y0 || y >= rect.y1) continue;
          expect(askedKeys.has(`${Math.floor(x / TILE_SIZE_PX)},${Math.floor(y / TILE_SIZE_PX)}`), `${x},${y}`).toBe(
            true,
          );
        }
      }
    }
  });

  it('a rectangle in the last pixel row and column asks for the last tile and nothing past it', () => {
    const plan = planPage(2048.25, 1024.25, 8); // 8193 x 4097
    expect(tilesIn(plan, { x0: 8192, y0: 4096, x1: 8193, y1: 4097 })).toEqual([[8, 4]]);
    expect(tilesIn(plan, { x0: 8192, y0: 0, x1: 99_999, y1: 1 })).toEqual([[8, 0]]);
    // A rectangle that starts a whole tile beyond the page's edge has nothing of the page in it.
    expect(tilesIn(plan, { x0: 9300, y0: 4097 + 1100, x1: 12_000, y1: 9000 })).toEqual([]);
  });
});
