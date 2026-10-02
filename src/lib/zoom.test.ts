import { describe, expect, it } from 'vitest';

import { readPngSize } from './png';
import {
  CSS_PX_PER_PT,
  DEFAULT_ZOOM,
  FIT_SCROLLBAR_PX,
  MAX_RENDER_SCALE,
  MAX_ZOOM,
  MIN_RENDER_SCALE,
  MIN_ZOOM,
  clampZoom,
  fitPageZoom,
  fitWidthZoom,
  formatZoom,
  scaleForZoom,
  stepZoom,
  wheelZoom,
} from './zoom';

describe('zoom steps', () => {
  it('moves to the next preset and stops at the limits', () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
  });

  it('steps from values between presets', () => {
    expect(stepZoom(1.2, 1)).toBe(1.25);
    expect(stepZoom(1.2, -1)).toBe(1.1);
  });

  it('clamps zoom and replaces non-finite values with the default', () => {
    expect(clampZoom(100)).toBe(MAX_ZOOM);
    expect(clampZoom(0.01)).toBe(MIN_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(DEFAULT_ZOOM);
  });

  it('formats percentages', () => {
    expect(formatZoom(1)).toBe('100%');
    expect(formatZoom(0.67)).toBe('67%');
  });
});

describe('fit zoom', () => {
  // A US Letter page (612 x 792 pt) is 816 x 1056 CSS px at 100 %.
  it('fit width fills the width less the scrollbar allowance', () => {
    expect(fitWidthZoom(816 + FIT_SCROLLBAR_PX, 612)).toBeCloseTo(1);
    expect(fitWidthZoom(1632 + FIT_SCROLLBAR_PX, 612)).toBeCloseTo(2);
    expect(fitWidthZoom(408 + FIT_SCROLLBAR_PX, 612)).toBeCloseTo(0.5);
  });

  it('fit page takes the smaller of the width fit and the height fit', () => {
    // Plenty of height: the width decides. Plenty of width: the height decides.
    expect(fitPageZoom(816, 5000, 612, 792)).toBeCloseTo(1);
    expect(fitPageZoom(5000, 528, 612, 792)).toBeCloseTo(0.5);
    // A landscape page in a portrait canvas.
    expect(fitPageZoom(816, 1056, 792, 612)).toBeCloseTo(816 / (792 * CSS_PX_PER_PT));
  });

  it('stays inside the zoom range', () => {
    expect(fitWidthZoom(100_000, 100)).toBe(MAX_ZOOM);
    expect(fitWidthZoom(FIT_SCROLLBAR_PX + 1, 612)).toBe(MIN_ZOOM);
    expect(fitWidthZoom(FIT_SCROLLBAR_PX, 612)).toBe(MIN_ZOOM);
    expect(fitPageZoom(100_000, 100_000, 100, 100)).toBe(MAX_ZOOM);
    expect(fitPageZoom(10, 10, 612, 792)).toBe(MIN_ZOOM);
  });

  it('is null until the canvas is measured and the page has a size', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(fitWidthZoom(bad, 612), `viewport ${bad}`).toBeNull();
      expect(fitWidthZoom(800, bad), `page ${bad}`).toBeNull();
      expect(fitPageZoom(bad, 600, 612, 792), `viewport width ${bad}`).toBeNull();
      expect(fitPageZoom(800, bad, 612, 792), `viewport height ${bad}`).toBeNull();
      expect(fitPageZoom(800, 600, bad, 792), `page width ${bad}`).toBeNull();
      expect(fitPageZoom(800, 600, 612, bad), `page height ${bad}`).toBeNull();
    }
  });
});

describe('wheel zoom', () => {
  it('zooms in on negative deltas and out on positive deltas', () => {
    expect(wheelZoom(1, -100)).toBeGreaterThan(1);
    expect(wheelZoom(1, 100)).toBeLessThan(1);
    expect(wheelZoom(1, 0)).toBe(1);
  });

  it('treats line and page deltas as larger than pixel deltas', () => {
    expect(wheelZoom(1, -3, 1)).toBeGreaterThan(wheelZoom(1, -3, 0));
    expect(wheelZoom(1, -1, 2)).toBeGreaterThan(wheelZoom(1, -1, 1));
  });

  it('never leaves the zoom range', () => {
    expect(wheelZoom(MAX_ZOOM, -10_000)).toBe(MAX_ZOOM);
    expect(wheelZoom(MIN_ZOOM, 10_000)).toBe(MIN_ZOOM);
  });
});

describe('render scale', () => {
  it('maps 100 % on a 1x display to 96 dpi', () => {
    expect(scaleForZoom(1, 1)).toBeCloseTo(CSS_PX_PER_PT);
  });

  it('scales with the device pixel ratio', () => {
    expect(scaleForZoom(1, 2)).toBeCloseTo(2 * CSS_PX_PER_PT);
  });

  it('stays inside the backend limits', () => {
    expect(scaleForZoom(MAX_ZOOM, 3)).toBe(MAX_RENDER_SCALE);
    expect(scaleForZoom(MIN_ZOOM, 0.1)).toBe(MIN_RENDER_SCALE);
  });

  it('falls back to a ratio of 1 for bad pixel ratios', () => {
    expect(scaleForZoom(1, 0)).toBeCloseTo(CSS_PX_PER_PT);
    expect(scaleForZoom(1, Number.NaN)).toBeCloseTo(CSS_PX_PER_PT);
  });
});

describe('png size', () => {
  // 8-byte signature, IHDR length, "IHDR", width 612, height 792.
  const header = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x02, 0x64, 0, 0, 0x03,
    0x18,
  ]);

  it('reads width and height from the header', () => {
    expect(readPngSize(header)).toEqual({ width: 612, height: 792 });
  });

  it('rejects anything that is not a PNG header', () => {
    expect(readPngSize(new Uint8Array(0))).toBeNull();
    expect(readPngSize(header.slice(0, 20))).toBeNull();
    const notPng = header.slice();
    notPng[1] = 0;
    expect(readPngSize(notPng)).toBeNull();
  });
});
